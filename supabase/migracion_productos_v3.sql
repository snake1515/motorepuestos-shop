-- JK2M Repuestos — migración "productos v3" (carga masiva como la de Moto Speed)
-- Ejecutar completo en Supabase: SQL Editor > New query > pegar > Run.
-- Es seguro correrlo más de una vez. Requiere migracion_tienda_v2.sql.
--
-- Qué agrega:
--   1) Marca, "compatible con" (motos donde sirve) y descripción de cada producto.
--   2) "Publicado en la tienda": un producto oculto sigue en el panel pero no se ve
--      ni se puede pedir en la tienda.
--   3) La búsqueda de la tienda también encuentra por marca y por moto compatible.

alter table products add column if not exists marca text;
alter table products add column if not exists compatibilidad text;
alter table products add column if not exists descripcion text;
alter table products add column if not exists en_tienda boolean not null default true;

create or replace function products_busqueda() returns trigger
language plpgsql as $$
begin
  new.busqueda := norm_text(new.name || ' ' || coalesce(new.code, '') || ' ' || coalesce(new.category, '')
                  || ' ' || coalesce(new.marca, '') || ' ' || coalesce(new.compatibilidad, ''));
  return new;
end;
$$;
drop trigger if exists products_busqueda on products;
create trigger products_busqueda before insert or update of name, code, category, marca, compatibilidad on products
  for each row execute function products_busqueda();
update products set busqueda = norm_text(name || ' ' || coalesce(code, '') || ' ' || coalesce(category, '')
                  || ' ' || coalesce(marca, '') || ' ' || coalesce(compatibilidad, ''));

-- Catálogo, ficha y categorías: solo productos publicados en la tienda
create or replace function catalog_page(
  p_q text default '',
  p_cat text default null,
  p_sort text default '',
  p_page int default 1,
  p_size int default 24
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_words text[];
  v_agotados boolean;
  v_size int := least(greatest(coalesce(p_size, 24), 1), 60);
  v_off int := (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_size, 24), 1), 60);
  v_out jsonb;
begin
  select mostrar_agotados into v_agotados from settings where id = 1;
  v_agotados := coalesce(v_agotados, true);
  v_words := array_remove(regexp_split_to_array(norm_text(trim(coalesce(p_q, ''))), '\s+'), '');
  v_words := v_words[1:6];

  with r as (select * from reserved_qty()),
  vis as (
    select p.id, p.name, p.code, p.category, p.price, p.image_url, p.featured, p.marca, p.compatibilidad,
           greatest(p.stock - coalesce(r.qty, 0), 0)::int as disponible
    from products p left join r on r.product_id = p.id
    where p.price > 0 and p.en_tienda
      and (coalesce(p_cat, '') = '' or p.category = p_cat)
      and not exists (select 1 from unnest(v_words) w where coalesce(p.busqueda, '') not like '%' || w || '%')
  ),
  vis2 as (select * from vis where v_agotados or disponible > 0),
  numbered as (
    select v.*, row_number() over (order by
        case when p_sort = 'price_asc' then v.price end asc nulls last,
        case when p_sort = 'price_desc' then v.price end desc nulls last,
        v.featured desc, (v.disponible > 0) desc, (v.image_url is not null) desc, v.name, v.id) as rn
    from vis2 v
  )
  select jsonb_build_object(
    'total', (select count(*) from vis2),
    'items', coalesce((select jsonb_agg(to_jsonb(n) - 'rn' order by n.rn) from numbered n
                       where n.rn > v_off and n.rn <= v_off + v_size), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;


create or replace function products_by_ids(p_ids bigint[])
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'code', p.code, 'category', p.category, 'price', p.price,
      'image_url', p.image_url, 'featured', p.featured,
      'marca', p.marca, 'compatibilidad', p.compatibilidad, 'descripcion', p.descripcion,
      'disponible', greatest(p.stock - coalesce(r.qty, 0), 0)::int)), '[]'::jsonb)
  from products p left join reserved_qty() r on r.product_id = p.id
  where p.id = any (p_ids[1:100]) and p.en_tienda;
$$;


create or replace function category_list()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(category order by category), '[]'::jsonb)
  from (select distinct category from products where price > 0 and en_tienda) c;
$$;


-- Crear pedido: un producto oculto no se puede pedir
create or replace function create_order(
  p_name text,
  p_email text,
  p_whatsapp text,
  p_items jsonb,
  p_nit_cc text default null,
  p_entrega text default 'recoger',
  p_direccion text default null,
  p_ciudad text default null,
  p_nota text default null,
  p_medio text default null,
  p_trap text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_s        settings%rowtype;
  v_pct      numeric := 0;
  v_order_id bigint;
  v_token    text;
  v_created  timestamptz;
  v_total    numeric := 0;
  v_nit      text;
  v_wa       text;
  v_name     text;
  v_entrega  text;
  v_ip       text;
  v_items    jsonb;
  v_err      text[] := '{}';
  rec        record;
begin
  select * into v_s from settings where id = 1;
  if v_s.id is not null and not v_s.tienda_abierta then
    raise exception '%', coalesce(nullif(v_s.mensaje_cerrada, ''), 'La tienda está cerrada en este momento.');
  end if;

  -- Campo trampa: las personas no lo ven; los robots lo llenan
  if coalesce(p_trap, '') <> '' then
    raise exception 'No se pudo procesar el pedido.';
  end if;

  v_name := left(trim(coalesce(p_name, '')), 120);
  if length(v_name) < 3 then
    raise exception 'Escribe tu nombre.';
  end if;

  v_wa := regexp_replace(coalesce(p_whatsapp, ''), '[^0-9]', '', 'g');
  if v_wa = '' then
    raise exception 'Falta el número de WhatsApp';
  end if;
  if length(v_wa) < 10 or length(v_wa) > 15 then
    raise exception 'El WhatsApp debe tener entre 10 y 15 dígitos';
  end if;

  v_nit := nullif(left(regexp_replace(coalesce(p_nit_cc, ''), '[^0-9-]', '', 'g'), 20), '');
  if v_nit is null then
    raise exception 'Falta el NIT o CC';
  end if;
  if length(replace(v_nit, '-', '')) < 5 or length(replace(v_nit, '-', '')) > 15 then
    raise exception 'El NIT o CC debe tener entre 5 y 15 dígitos';
  end if;

  v_entrega := case when p_entrega in ('recoger', 'domicilio', 'envio') then p_entrega else 'recoger' end;
  if v_entrega = 'domicilio' and not coalesce(v_s.domicilio, true) then v_entrega := 'recoger'; end if;
  if v_entrega = 'envio' and not coalesce(v_s.envio_nacional, true) then v_entrega := 'recoger'; end if;
  if v_entrega <> 'recoger' and length(trim(coalesce(p_direccion, ''))) < 5 then
    raise exception 'Escribe la dirección de entrega.';
  end if;
  if v_entrega = 'envio' and length(trim(coalesce(p_ciudad, ''))) < 3 then
    raise exception 'Escribe la ciudad de envío.';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'El carrito está vacío';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'Demasiados artículos en un solo pedido';
  end if;

  -- Límite de pedidos seguidos (por número de WhatsApp y por conexión)
  begin
    v_ip := split_part(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for', ',', 1);
  exception when others then v_ip := null;
  end;
  v_ip := nullif(trim(coalesce(v_ip, '')), '');
  if (select count(*) from orders where whatsapp = v_wa and created_at > now() - interval '1 hour') >= 6
     or (v_ip is not null and (select count(*) from orders where client_ip = v_ip and created_at > now() - interval '1 hour') >= 8) then
    raise exception 'Hiciste muchos pedidos seguidos. Escríbenos por WhatsApp.';
  end if;

  select pr.pct into v_pct from profiles pr where pr.id = auth.uid();
  v_pct := coalesce(v_pct, 0);

  -- Se bloquean los productos pedidos (en orden) para que dos pedidos a la vez
  -- no se lleven la misma unidad; luego se compara con lo disponible.
  perform 1 from products p
    where p.id in (select (e->>'product_id')::bigint from jsonb_array_elements(p_items) e)
    order by p.id for update;
  for rec in
    with i as (
      select (e->>'product_id')::bigint as product_id, sum((e->>'qty')::int) as qty
      from jsonb_array_elements(p_items) e group by 1
    )
    select i.product_id, i.qty, p.name, p.stock, coalesce(r.qty, 0) as reservado
    from i left join products p on p.id = i.product_id and p.en_tienda
    left join reserved_qty() r on r.product_id = i.product_id
  loop
    if rec.name is null then
      v_err := v_err || 'Un producto del carrito ya no existe. Actualiza la página.';
    elsif rec.qty < 1 or rec.qty > 999 then
      v_err := v_err || format('Cantidad no válida para «%s».', rec.name);
    elsif rec.qty > greatest(rec.stock - rec.reservado, 0) then
      v_err := v_err || format('De «%s» solo hay %s disponibles.', rec.name, greatest(rec.stock - rec.reservado, 0));
    end if;
  end loop;
  if cardinality(v_err) > 0 then
    raise exception '%', array_to_string(v_err, ' ');
  end if;

  insert into orders (user_email, whatsapp, nit_cc, customer_name, total, status, entrega,
                      direccion, ciudad, nota, medio_pago, client_ip)
  values (
    nullif(left(trim(coalesce(p_email, '')), 200), ''), v_wa, v_nit, v_name, 0, 'pendiente', v_entrega,
    case when v_entrega <> 'recoger' then nullif(left(trim(coalesce(p_direccion, '')), 200), '') end,
    case when v_entrega <> 'recoger' then nullif(left(trim(coalesce(p_ciudad, '')), 80), '') end,
    nullif(left(trim(coalesce(p_nota, '')), 400), ''),
    nullif(left(trim(coalesce(p_medio, '')), 60), ''),
    v_ip
  )
  returning id, token, created_at into v_order_id, v_token, v_created;

  insert into order_items (order_id, product_id, code, name, qty, price)
  select v_order_id, p.id, p.code, p.name, i.qty, round(p.price * (1 - v_pct / 100))
  from (
    select (e->>'product_id')::bigint as product_id, sum((e->>'qty')::int) as qty
    from jsonb_array_elements(p_items) e group by 1
  ) i
  join products p on p.id = i.product_id;

  select coalesce(sum(qty * price), 0) into v_total from order_items where order_id = v_order_id;
  if v_total <= 0 then
    raise exception 'Ningún artículo válido en el pedido';
  end if;
  update orders set total = v_total where id = v_order_id;

  select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'qty', qty, 'price', price) order by id)
  into v_items from order_items where order_id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id, 'token', v_token, 'total', v_total, 'created_at', v_created,
    'nit_cc', v_nit, 'whatsapp', v_wa, 'name', v_name, 'entrega', v_entrega,
    'direccion', case when v_entrega <> 'recoger' then nullif(trim(coalesce(p_direccion, '')), '') end,
    'ciudad', case when v_entrega <> 'recoger' then nullif(trim(coalesce(p_ciudad, '')), '') end,
    'medio_pago', nullif(trim(coalesce(p_medio, '')), ''),
    'items', v_items
  );
end;
$$;


grant execute on function catalog_page(text, text, text, int, int) to anon, authenticated;
grant execute on function products_by_ids(bigint[]) to anon, authenticated;
grant execute on function category_list() to anon, authenticated;
grant execute on function create_order(text, text, text, jsonb, text, text, text, text, text, text, text) to anon, authenticated;
