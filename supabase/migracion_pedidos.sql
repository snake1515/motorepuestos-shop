-- MotoRepuestos — migración: crear pedidos mediante función segura (RPC)
-- Ejecutar completo en Supabase: SQL Editor > New query > pegar > Run.
-- Es seguro correrlo más de una vez.

-- 1) Columnas que el frontend ya usa (si ya existen, no pasa nada)
alter table orders add column if not exists whatsapp text;
alter table orders alter column user_email drop not null;
-- Código del producto guardado en cada línea del pedido (se ve en el comprobante y en el admin)
alter table order_items add column if not exists code text;
-- NIT o cédula del cliente (para facturación)
alter table orders add column if not exists nit_cc text;

-- 2) Función que crea el pedido completo en una sola transacción.
--    - Recibe solo product_id y cantidad (nunca precios).
--    - Calcula el precio en el servidor con el descuento (pct) del cliente logueado.
--    - Si algo falla, no queda ningún pedido a medias.
--    - Funciona para visitantes sin cuenta y para clientes logueados.
-- Se reemplaza la versión anterior (4 parámetros) por una con p_nit_cc al final.
-- El NIT/CC es OBLIGATORIO: la función rechaza el pedido si falta o no es válido,
-- así que sube el nuevo app.js e index.html justo después de correr este SQL.
drop function if exists create_order(text, text, text, jsonb);

create or replace function create_order(
  p_name text,
  p_email text,
  p_whatsapp text,
  p_items jsonb,
  p_nit_cc text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pct      numeric := 0;
  v_order_id bigint;
  v_created  timestamptz;
  v_total    numeric := 0;
  v_nit      text;
  v_wa       text;
  v_items    jsonb;
begin
  -- WhatsApp OBLIGATORIO: se guarda solo con dígitos (10 a 15, admite indicativo de país)
  v_wa := regexp_replace(coalesce(p_whatsapp, ''), '[^0-9]', '', 'g');
  if v_wa = '' then
    raise exception 'Falta el número de WhatsApp';
  end if;
  if length(v_wa) < 10 or length(v_wa) > 15 then
    raise exception 'El WhatsApp debe tener entre 10 y 15 dígitos';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'El carrito está vacío';
  end if;

  if jsonb_array_length(p_items) > 100 then
    raise exception 'Demasiados artículos en un solo pedido';
  end if;

  -- Descuento del cliente logueado (0 si es visitante o no tiene perfil)
  select pr.pct into v_pct from profiles pr where pr.id = auth.uid();
  v_pct := coalesce(v_pct, 0);

  -- NIT/CC: solo dígitos y guion (para el dígito de verificación), máximo 20 caracteres
  v_nit := nullif(left(regexp_replace(coalesce(p_nit_cc, ''), '[^0-9-]', '', 'g'), 20), '');

  if v_nit is null then
    raise exception 'Falta el NIT o CC';
  end if;
  if length(replace(v_nit, '-', '')) < 5 or length(replace(v_nit, '-', '')) > 15 then
    raise exception 'El NIT o CC debe tener entre 5 y 15 dígitos';
  end if;

  insert into orders (user_email, whatsapp, nit_cc, customer_name, total)
  values (
    nullif(left(trim(coalesce(p_email, '')), 200), ''),
    v_wa,
    v_nit,
    left(trim(coalesce(p_name, '')), 120),
    0
  )
  returning id, created_at into v_order_id, v_created;

  insert into order_items (order_id, product_id, code, name, qty, price)
  select v_order_id, p.id, p.code, p.name, i.qty, round(p.price * (1 - v_pct / 100))
  from (
    select (e->>'product_id')::bigint as product_id,
           sum((e->>'qty')::int)      as qty
    from jsonb_array_elements(p_items) e
    group by 1
  ) i
  join products p on p.id = i.product_id
  where i.qty > 0 and i.qty <= 999;

  select coalesce(sum(qty * price), 0) into v_total
  from order_items where order_id = v_order_id;

  if v_total <= 0 then
    -- Al lanzar la excepción se deshace todo, incluido el pedido recién insertado
    raise exception 'Ningún artículo válido en el pedido';
  end if;

  update orders set total = v_total where id = v_order_id;

  select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'qty', qty, 'price', price))
  into v_items
  from order_items where order_id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    'total', v_total,
    'created_at', v_created,
    'nit_cc', v_nit,
    'whatsapp', v_wa,
    'items', v_items
  );
end;
$$;

grant execute on function create_order(text, text, text, jsonb, text) to anon, authenticated;

-- 3) Cerrar los inserts directos: desde ahora los pedidos solo se crean con create_order().
--    (Antes cualquiera podía insertar pedidos con el total que quisiera.)
drop policy if exists orders_insert_all on orders;
drop policy if exists order_items_insert_all on order_items;

-- La lectura de pedidos sigue siendo solo para el admin (políticas orders_read_admin
-- y order_items_read_admin, sin cambios).
