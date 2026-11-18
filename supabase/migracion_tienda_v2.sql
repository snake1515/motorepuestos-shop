-- JK2M Repuestos — migración "tienda v2"
-- Ejecutar completo en Supabase: SQL Editor > New query > pegar > Run.
-- Es seguro correrlo más de una vez. Requiere haber corrido antes
-- migracion_pedidos.sql y migracion_seguridad_perfiles.sql.
--
-- Qué agrega:
--   1) Configuración de la tienda editable desde el panel (nombre, WhatsApp,
--      medios de pago, abrir/cerrar la tienda, mostrar agotados, horas de reserva).
--   2) Productos destacados y búsqueda sin tildes, por varias palabras.
--   3) Catálogo por páginas (24 productos por vez) con las unidades disponibles
--      descontando lo que está apartado por pedidos pendientes.
--   4) Pedidos con estado (pendiente, confirmado, entregado, cancelado), tipo de
--      entrega, dirección, forma de pago y nota. El stock se valida al pedir, los
--      pendientes apartan unidades, y al confirmar se descuenta el stock.
--   5) Página de estado del pedido para el cliente (por un enlace privado).
--   6) Protección contra pedidos repetidos o de robots.
--   7) Limpia 18 fotos que quedaron en blanco al sacarlas del catálogo en PDF.

-- ───────────────────────────── 1) Configuración ──────────────────────────
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  store_name text not null default 'JK2M Repuestos',
  whatsapp text,
  mensaje text,
  tienda_abierta boolean not null default true,
  mensaje_cerrada text not null default 'La tienda en línea está cerrada en este momento. Escríbenos por WhatsApp.',
  mostrar_agotados boolean not null default true,
  reserva_horas int not null default 48 check (reserva_horas between 1 and 720),
  domicilio boolean not null default true,
  envio_nacional boolean not null default true,
  medios_pago jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1) on conflict (id) do nothing;

alter table settings enable row level security;
drop policy if exists settings_read_all on settings;
create policy settings_read_all on settings for select using (true);
drop policy if exists settings_update_admin on settings;
create policy settings_update_admin on settings for update using (is_admin()) with check (is_admin());

-- ───────────────────────────── 2) Productos ──────────────────────────────
alter table products add column if not exists featured boolean not null default false;
alter table products add column if not exists busqueda text;

-- Texto en minúsculas y sin tildes, para buscar "bujia" y encontrar "Bujía"
create or replace function norm_text(t text) returns text
language sql immutable as $$
  select lower(translate(coalesce(t, ''), 'áéíóúüñÁÉÍÓÚÜÑàèìòùÀÈÌÒÙ', 'aeiouunaeiouunaeiouaeiou'));
$$;

create or replace function products_busqueda() returns trigger
language plpgsql as $$
begin
  new.busqueda := norm_text(new.name || ' ' || coalesce(new.code, '') || ' ' || coalesce(new.category, ''));
  return new;
end;
$$;
drop trigger if exists products_busqueda on products;
create trigger products_busqueda before insert or update of name, code, category on products
  for each row execute function products_busqueda();
update products set busqueda = norm_text(name || ' ' || coalesce(code, '') || ' ' || coalesce(category, ''))
  where busqueda is distinct from norm_text(name || ' ' || coalesce(code, '') || ' ' || coalesce(category, ''));

-- 18 fotos quedaron en blanco al extraerlas del PDF: se quitan para que muestre "Sin foto"
update products set image_url = null
  where image_url like 'data:%'
    and md5(image_url) in ('1e52b42685bac478ca123e357cd19f37', '654863b0f0aeb176a10a1e72a07e5405', 'ab132ed78b277fcc016ce0524273ffca');

-- ───────────────────────────── 4) Pedidos ────────────────────────────────
alter table orders add column if not exists status text not null default 'pendiente';
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('pendiente', 'confirmado', 'entregado', 'cancelado'));
alter table orders add column if not exists token text default replace(gen_random_uuid()::text, '-', '');
update orders set token = replace(gen_random_uuid()::text, '-', '') where token is null;
create unique index if not exists orders_token_idx on orders(token);
alter table orders add column if not exists entrega text not null default 'recoger';
alter table orders add column if not exists direccion text;
alter table orders add column if not exists ciudad text;
alter table orders add column if not exists nota text;
alter table orders add column if not exists medio_pago text;
alter table orders add column if not exists client_ip text;
alter table orders add column if not exists stock_descontado boolean not null default false;
alter table orders add column if not exists confirmed_at timestamptz;
alter table orders add column if not exists delivered_at timestamptz;
alter table orders add column if not exists cancelled_at timestamptz;
create index if not exists orders_status_idx on orders(status, created_at desc);

-- Los pedidos anteriores quedan como "pendiente". Los que tienen más de las horas
-- de reserva ya no apartan stock; en el panel se ven como "reserva vencida" para
-- que los marques como entregados o cancelados.

-- Unidades apartadas por pedidos pendientes que aún no vencen
create or replace function reserved_qty()
returns table (product_id bigint, qty bigint)
language sql stable security definer set search_path = public as $$
  select oi.product_id, sum(oi.qty)::bigint
  from order_items oi
  join orders o on o.id = oi.order_id
  cross join settings s
  where s.id = 1 and o.status = 'pendiente' and oi.product_id is not null
    and o.created_at >= now() - make_interval(hours => s.reserva_horas)
  group by oi.product_id;
$$;

-- ───────────────────────────── 3) Catálogo por páginas ───────────────────
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
    select p.id, p.name, p.code, p.category, p.price, p.image_url, p.featured,
           greatest(p.stock - coalesce(r.qty, 0), 0)::int as disponible
    from products p left join r on r.product_id = p.id
    where p.price > 0
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

-- Productos puntuales (carrito, ficha del producto) con sus unidades disponibles
create or replace function products_by_ids(p_ids bigint[])
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'code', p.code, 'category', p.category, 'price', p.price,
      'image_url', p.image_url, 'featured', p.featured,
      'disponible', greatest(p.stock - coalesce(r.qty, 0), 0)::int)), '[]'::jsonb)
  from products p left join reserved_qty() r on r.product_id = p.id
  where p.id = any (p_ids[1:100]);
$$;

-- Categorías que tienen al menos un producto con precio (para las fichas de la tienda)
create or replace function category_list()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(category order by category), '[]'::jsonb)
  from (select distinct category from products where price > 0) c;
$$;

-- ───────────────────────────── Crear pedido ──────────────────────────────
drop function if exists create_order(text, text, text, jsonb);
drop function if exists create_order(text, text, text, jsonb, text);

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
    from i left join products p on p.id = i.product_id
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

-- ───────────────────────────── 5) Estado del pedido (cliente) ─────────────
create or replace function get_order(p_token text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'status', o.status, 'created_at', o.created_at, 'total', o.total,
    'name', o.customer_name, 'nit_cc', o.nit_cc, 'whatsapp', o.whatsapp, 'entrega', o.entrega,
    'direccion', o.direccion, 'ciudad', o.ciudad, 'medio_pago', o.medio_pago, 'nota', o.nota,
    'vence', o.created_at + make_interval(hours => s.reserva_horas),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'name', i.name, 'qty', i.qty, 'price', i.price) order by i.id), '[]'::jsonb)
              from order_items i where i.order_id = o.id))
  from orders o cross join settings s
  where s.id = 1 and length(coalesce(p_token, '')) >= 16 and o.token = p_token;
$$;

-- ───────────────────────────── Cambiar estado (admin) ─────────────────────
-- Confirmar (o entregar un pendiente) descuenta el stock; cancelar uno que ya
-- lo descontó lo devuelve.
create or replace function set_order_status(p_id bigint, p_status text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  v_err text[] := '{}';
  rec record;
begin
  if not is_admin() then
    raise exception 'Solo el administrador puede cambiar el estado de un pedido';
  end if;
  if p_status not in ('pendiente', 'confirmado', 'entregado', 'cancelado') then
    raise exception 'Estado no válido';
  end if;
  select * into o from orders where id = p_id for update;
  if o.id is null then
    raise exception 'El pedido no existe';
  end if;
  if o.status = p_status then
    return jsonb_build_object('id', o.id, 'status', o.status);
  end if;
  if o.status = 'cancelado' and p_status <> 'pendiente' then
    raise exception 'Un pedido cancelado solo se puede reabrir como pendiente';
  end if;

  if p_status in ('confirmado', 'entregado') and not o.stock_descontado then
    perform 1 from products where id in (select product_id from order_items where order_id = o.id) order by id for update;
    for rec in
      select p.id, p.name, p.stock, sum(i.qty) as qty
      from order_items i join products p on p.id = i.product_id
      where i.order_id = o.id group by p.id, p.name, p.stock order by p.id
    loop
      if rec.qty > rec.stock then
        v_err := v_err || format('«%s»: el pedido lleva %s y el stock es %s.', rec.name, rec.qty, rec.stock);
      end if;
    end loop;
    if cardinality(v_err) > 0 then
      raise exception 'No alcanza el stock. % Ajusta el stock del producto y vuelve a intentarlo.', array_to_string(v_err, ' ');
    end if;
    update products p set stock = p.stock - x.qty
    from (select product_id, sum(qty) as qty from order_items where order_id = o.id and product_id is not null group by 1) x
    where p.id = x.product_id;
    o.stock_descontado := true;
  elsif p_status in ('cancelado', 'pendiente') and o.stock_descontado then
    update products p set stock = p.stock + x.qty
    from (select product_id, sum(qty) as qty from order_items where order_id = o.id and product_id is not null group by 1) x
    where p.id = x.product_id;
    o.stock_descontado := false;
  end if;

  update orders set
    status = p_status,
    stock_descontado = o.stock_descontado,
    confirmed_at = case when p_status in ('confirmado', 'entregado') then coalesce(confirmed_at, now()) when p_status = 'pendiente' then null else confirmed_at end,
    delivered_at = case when p_status = 'entregado' then now() when p_status = 'pendiente' then null else delivered_at end,
    cancelled_at = case when p_status = 'cancelado' then now() when p_status = 'pendiente' then null else cancelled_at end,
    -- reabrir un pedido vuelve a contar las horas de reserva desde ahora
    created_at = case when p_status = 'pendiente' then now() else created_at end
  where id = o.id;
  return jsonb_build_object('id', o.id, 'status', p_status);
end;
$$;

-- ───────────────────────────── Permisos ──────────────────────────────────
revoke all on function reserved_qty() from public, anon, authenticated;
grant execute on function catalog_page(text, text, text, int, int) to anon, authenticated;
grant execute on function products_by_ids(bigint[]) to anon, authenticated;
grant execute on function category_list() to anon, authenticated;
grant execute on function create_order(text, text, text, jsonb, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function get_order(text) to anon, authenticated;
revoke all on function set_order_status(bigint, text) from public, anon;
grant execute on function set_order_status(bigint, text) to authenticated;

-- Los pedidos solo se crean con create_order (sin inserts directos)
drop policy if exists orders_insert_all on orders;
drop policy if exists order_items_insert_all on order_items;
