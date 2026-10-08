-- MotoRepuestos — esquema de base de datos para Supabase
-- Ejecuta este archivo completo en Supabase: Dashboard > SQL Editor > New query > pega y corre.

-- ───────────────────────────── Categorías ─────────────────────────────
create table if not exists categories (
  id bigint generated always as identity primary key,
  name text unique not null
);

-- ───────────────────────────── Productos ──────────────────────────────
create table if not exists products (
  id bigint generated always as identity primary key,
  name text not null,
  code text unique,
  category text not null default 'Sin categoría',
  price numeric not null default 0,
  stock int not null default 0,
  image_url text,
  created_at timestamptz default now()
);
create index if not exists products_category_idx on products(category);

-- ───────────────────────── Perfiles de cliente ────────────────────────
-- Un perfil por usuario de auth.users. "tipo" y "pct" controlan el precio
-- que ve cada cliente (editable a mano por el admin, sin topes automáticos).
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  tipo text not null default 'Detalle',
  pct numeric not null default 0,
  is_admin boolean not null default false,
  created_at timestamptz default now()
);

-- ───────────────────────────── Pedidos ────────────────────────────────
create table if not exists orders (
  id bigint generated always as identity primary key,
  user_email text not null,
  customer_name text,
  total numeric not null default 0,
  created_at timestamptz default now()
);

create table if not exists order_items (
  id bigint generated always as identity primary key,
  order_id bigint references orders(id) on delete cascade,
  product_id bigint references products(id) on delete set null,
  name text not null,
  qty int not null,
  price numeric not null
);

-- ───────────────────────────── Seguridad (RLS) ────────────────────────
alter table categories enable row level security;
alter table products enable row level security;
alter table profiles enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;

-- Función auxiliar: ¿el usuario actual es admin? (security definer evita
-- recursión infinita al consultar la propia tabla profiles desde una política)
create or replace function is_admin()
returns boolean
language sql
security definer
stable
as $$
  select coalesce((select p.is_admin from profiles p where p.id = auth.uid()), false);
$$;

-- Categorías: cualquiera puede leer; solo el admin escribe
drop policy if exists categories_read_all on categories;
create policy categories_read_all on categories for select using (true);
drop policy if exists categories_write_admin on categories;
create policy categories_write_admin on categories for all using (is_admin()) with check (is_admin());

-- Productos: cualquiera puede leer (catálogo público); solo el admin escribe
drop policy if exists products_read_all on products;
create policy products_read_all on products for select using (true);
drop policy if exists products_write_admin on products;
create policy products_write_admin on products for all using (is_admin()) with check (is_admin());

-- Perfiles: cada quien ve/edita el suyo; el admin ve y edita todos
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select using (auth.uid() = id or is_admin());
drop policy if exists profiles_insert on profiles;
create policy profiles_insert on profiles for insert with check (auth.uid() = id);
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update using (auth.uid() = id or is_admin()) with check (auth.uid() = id or is_admin());
drop policy if exists profiles_delete_admin on profiles;
create policy profiles_delete_admin on profiles for delete using (is_admin());

-- Pedidos: cualquiera (incluso sin cuenta) puede crear uno al pagar;
-- solo el admin puede verlos
drop policy if exists orders_insert_all on orders;
create policy orders_insert_all on orders for insert with check (true);
drop policy if exists orders_read_admin on orders;
create policy orders_read_admin on orders for select using (is_admin());
drop policy if exists order_items_insert_all on order_items;
create policy order_items_insert_all on order_items for insert with check (true);
drop policy if exists order_items_read_admin on order_items;
create policy order_items_read_admin on order_items for select using (is_admin());

-- ───────────────── Bucket de imágenes de producto ─────────────────────
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists product_images_public_read on storage.objects;
create policy product_images_public_read on storage.objects
  for select using (bucket_id = 'product-images');

drop policy if exists product_images_admin_write on storage.objects;
create policy product_images_admin_write on storage.objects
  for insert with check (bucket_id = 'product-images' and is_admin());

drop policy if exists product_images_admin_update on storage.objects;
create policy product_images_admin_update on storage.objects
  for update using (bucket_id = 'product-images' and is_admin());

drop policy if exists product_images_admin_delete on storage.objects;
create policy product_images_admin_delete on storage.objects
  for delete using (bucket_id = 'product-images' and is_admin());

-- ───────────────── Cómo convertirte en administrador ──────────────────
-- 1. Crea tu cuenta normal desde la tienda ya desplegada (botón Ingresar > Crear cuenta).
-- 2. Vuelve aquí y corre (cambia el correo):
--   update profiles set is_admin = true where email = 'tu-correo@ejemplo.com';
