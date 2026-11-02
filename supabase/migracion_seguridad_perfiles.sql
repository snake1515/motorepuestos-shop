-- JK2M Repuestos — migración de seguridad: perfiles de cliente
-- Ejecutar completo en Supabase: SQL Editor > New query > pegar > Run.
-- Es seguro correrlo más de una vez.
--
-- PROBLEMA QUE CIERRA
--   La política profiles_update dejaba que cada cliente editara SU PROPIA fila,
--   incluidas las columnas is_admin y pct. Cualquier persona con cuenta podía,
--   desde la consola del navegador, ejecutar:
--       sb.from('profiles').update({ is_admin: true, pct: 90 }).eq('id', miId)
--   y quedar como administrador (cambiar precios, borrar productos, leer todos
--   los pedidos con NIT/CC y WhatsApp) o darse un 90 % de descuento.
--   La política profiles_insert permitía lo mismo al crear el perfil.
--
-- QUÉ HACE
--   1) Los perfiles los crea la base de datos (trigger al registrarse), nunca el navegador.
--   2) Solo el administrador puede crear, editar o borrar perfiles.
--   3) Los clientes siguen pudiendo VER su propio perfil (para ver su precio).
--   4) is_admin() queda con search_path fijo (buena práctica en funciones security definer).
--   5) Crea el perfil que falte a quienes ya se registraron sin tenerlo.

-- 1) is_admin() endurecida
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- 2) Perfil automático al registrarse (funciona también con confirmación de correo activada)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Perfiles faltantes de cuentas que ya existían
insert into public.profiles (id, email)
select u.id, coalesce(u.email, '')
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- 3) Políticas de profiles: el cliente solo lee la suya; escribir es solo del admin
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles
  for select using (auth.uid() = id or is_admin());

drop policy if exists profiles_insert on profiles;
drop policy if exists profiles_insert_admin on profiles;
create policy profiles_insert_admin on profiles
  for insert with check (is_admin());

drop policy if exists profiles_update on profiles;
drop policy if exists profiles_update_admin on profiles;
create policy profiles_update_admin on profiles
  for update using (is_admin()) with check (is_admin());

drop policy if exists profiles_delete_admin on profiles;
create policy profiles_delete_admin on profiles
  for delete using (is_admin());

-- 4) Refuerzo: aunque alguien edite su perfil por otra vía, un no-admin no puede
--    cambiar is_admin, pct ni tipo (protege si en el futuro se abre otra política).
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sin usuario (SQL Editor, service_role, trigger de registro) se permite todo
  if auth.uid() is null then
    return new;
  end if;
  if not public.is_admin() and (
       new.is_admin is distinct from old.is_admin
    or new.pct      is distinct from old.pct
    or new.tipo     is distinct from old.tipo
    or new.id       is distinct from old.id) then
    raise exception 'Solo el administrador puede cambiar el tipo, el descuento o el rol de un cliente';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard on profiles;
create trigger profiles_guard
  before update on profiles
  for each row execute function public.profiles_guard();

-- 5) Pedidos: confirmar que no quedan inserts directos (los pedidos se crean con create_order)
drop policy if exists orders_insert_all on orders;
drop policy if exists order_items_insert_all on order_items;

-- Para revisar el resultado:
--   select policyname, cmd from pg_policies where tablename = 'profiles';
