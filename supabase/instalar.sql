-- Mi Sueldo · instalación en Supabase.
-- Pégalo completo en SQL Editor y pulsa Run. Se puede volver a ejecutar sin perder datos.
--
-- Cómo queda protegido:
--   * Nadie lee ni escribe las tablas directamente (RLS activo y sin permisos).
--   * Todo pasa por las funciones de abajo, que piden el PIN en cada llamada.
--   * Los PIN se guardan cifrados. Tras 5 intentos fallidos, ese perfil se bloquea 15 minutos.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ms_familia (
  id int primary key default 1 check (id = 1),          -- una sola familia por proyecto
  estado jsonb not null,
  version int not null default 1,
  actualizado timestamptz not null default now()
);

create table if not exists public.ms_pin (
  perfil text primary key,                               -- 'admin' o el id del niño
  hash text not null,
  fallos int not null default 0,
  bloqueado_hasta timestamptz
);

alter table public.ms_familia enable row level security;
alter table public.ms_pin enable row level security;
revoke all on public.ms_familia, public.ms_pin from anon, authenticated;

-- Comprueba un PIN y lleva la cuenta de intentos. Devuelve 'ok', 'pin' o 'bloqueado'.
create or replace function public.ms_verificar(p_perfil text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare r public.ms_pin;
begin
  select * into r from public.ms_pin where perfil = p_perfil for update;
  if not found or p_pin is null then return 'pin'; end if;
  if r.bloqueado_hasta is not null and r.bloqueado_hasta > now() then return 'bloqueado'; end if;
  if r.hash = crypt(p_pin, r.hash) then
    update public.ms_pin set fallos = 0, bloqueado_hasta = null where perfil = p_perfil;
    return 'ok';
  end if;
  if r.fallos + 1 >= 5 then
    update public.ms_pin set fallos = 0, bloqueado_hasta = now() + interval '15 minutes' where perfil = p_perfil;
  else
    update public.ms_pin set fallos = r.fallos + 1 where perfil = p_perfil;
  end if;
  return 'pin';
end $$;

-- Lo que se ve antes de entrar: nombres y colores para elegir perfil.
create or replace function public.ms_perfiles() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((
    select jsonb_build_object(
      'configurada', true,
      'adminNombre', f.estado->'config'->>'adminNombre',
      'perfiles', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', n->>'id', 'nombre', n->>'nombre', 'color', n->>'color',
          'tienePin', exists (select 1 from public.ms_pin p where p.perfil = n->>'id')) order by ord)
        from jsonb_array_elements(f.estado->'ninos') with ordinality as t(n, ord)), '[]'::jsonb))
    from public.ms_familia f), jsonb_build_object('configurada', false));
$$;

-- Primera vez: crea la familia con el PIN del administrador. Solo funciona si aún no existe.
create or replace function public.ms_crear(p_pin text, p_estado jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.ms_familia) then
    return jsonb_build_object('ok', false, 'error', 'existe');
  end if;
  if p_pin is null or p_pin !~ '^\d{4,6}$' then
    return jsonb_build_object('ok', false, 'error', 'formato');
  end if;
  if jsonb_typeof(p_estado->'ninos') is distinct from 'array'
     or jsonb_typeof(p_estado->'movimientos') is distinct from 'array'
     or jsonb_typeof(p_estado->'config') is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'datos');
  end if;
  insert into public.ms_familia (id, estado) values (1, p_estado);
  insert into public.ms_pin (perfil, hash) values ('admin', crypt(p_pin, gen_salt('bf')));
  return jsonb_build_object('ok', true, 'version', 1);
end $$;

-- Entrar: el administrador recibe todo; un niño, solo su cuenta.
create or replace function public.ms_entrar(p_perfil text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v text;
  f public.ms_familia;
  v_nino jsonb;
begin
  v := public.ms_verificar(p_perfil, p_pin);
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  select * into f from public.ms_familia where id = 1;
  if p_perfil = 'admin' then
    return jsonb_build_object('ok', true, 'rol', 'admin', 'estado', f.estado, 'version', f.version,
      'conPin', coalesce((select jsonb_agg(perfil) from public.ms_pin where perfil <> 'admin'), '[]'::jsonb));
  end if;
  select n into v_nino from jsonb_array_elements(f.estado->'ninos') n where n->>'id' = p_perfil;
  if v_nino is null then return jsonb_build_object('ok', false, 'error', 'pin'); end if;
  return jsonb_build_object('ok', true, 'rol', 'nino', 'id', p_perfil, 'version', f.version,
    'estado', jsonb_build_object(
      'version', f.estado->'version',
      'config', f.estado->'config',
      'ninos', jsonb_build_array(v_nino),
      'movimientos', coalesce((
        select jsonb_agg(m order by ord)
        from jsonb_array_elements(f.estado->'movimientos') with ordinality as t(m, ord)
        where m->>'ninoId' = p_perfil), '[]'::jsonb)));
end $$;

-- Guardar (solo administrador). p_version evita pisar cambios hechos desde otro dispositivo.
create or replace function public.ms_guardar(p_pin text, p_estado jsonb, p_version int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v text;
  v_actual int;
begin
  v := public.ms_verificar('admin', p_pin);
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  if jsonb_typeof(p_estado->'ninos') is distinct from 'array'
     or jsonb_typeof(p_estado->'movimientos') is distinct from 'array'
     or jsonb_typeof(p_estado->'config') is distinct from 'object'
     or octet_length(p_estado::text) > 5000000 then
    return jsonb_build_object('ok', false, 'error', 'datos');
  end if;
  select version into v_actual from public.ms_familia where id = 1 for update;
  if v_actual is distinct from p_version then
    return jsonb_build_object('ok', false, 'error', 'version');
  end if;
  update public.ms_familia set estado = p_estado, version = version + 1, actualizado = now() where id = 1;
  return jsonb_build_object('ok', true, 'version', v_actual + 1);
end $$;

-- Crear o cambiar un PIN (solo administrador). p_perfil: 'admin' o el id del niño.
create or replace function public.ms_poner_pin(p_admin_pin text, p_perfil text, p_nuevo text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  v := public.ms_verificar('admin', p_admin_pin);
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  if p_nuevo is null or p_nuevo !~ '^\d{4,6}$' then
    return jsonb_build_object('ok', false, 'error', 'formato');
  end if;
  if p_perfil <> 'admin' and not exists (
    select 1 from public.ms_familia f, jsonb_array_elements(f.estado->'ninos') n where n->>'id' = p_perfil) then
    return jsonb_build_object('ok', false, 'error', 'perfil');
  end if;
  insert into public.ms_pin (perfil, hash) values (p_perfil, crypt(p_nuevo, gen_salt('bf')))
  on conflict (perfil) do update set hash = excluded.hash, fallos = 0, bloqueado_hasta = null;
  return jsonb_build_object('ok', true);
end $$;

-- Lo único que un niño puede cambiar, y solo en su propia cuenta: marcar una tarea como hecha o
-- proponer cuánto ahorrar en su próximo pago. Devuelve su cuenta actualizada.
--   p_accion: {"tipo":"tarea","tareaId":"...","hecha":true}  o  {"tipo":"ahorro","monto":15000}  (monto null = quitar)
create or replace function public.ms_nino_accion(p_perfil text, p_pin text, p_accion jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v text;
  f public.ms_familia;
  i int;
  j int;
  v_nino jsonb;
  v_monto numeric;
begin
  if p_perfil = 'admin' then return jsonb_build_object('ok', false, 'error', 'pin'); end if;
  v := public.ms_verificar(p_perfil, p_pin);
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  select * into f from public.ms_familia where id = 1 for update;
  select (ord - 1)::int, n into i, v_nino
  from jsonb_array_elements(f.estado->'ninos') with ordinality as t(n, ord) where n->>'id' = p_perfil;
  if i is null then return jsonb_build_object('ok', false, 'error', 'pin'); end if;

  if p_accion->>'tipo' = 'tarea' then
    select (ord - 1)::int into j
    from jsonb_array_elements(v_nino->'tareas') with ordinality as t(x, ord) where x->>'id' = p_accion->>'tareaId';
    if j is null or jsonb_typeof(p_accion->'hecha') is distinct from 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'datos');
    end if;
    f.estado := jsonb_set(f.estado, array['ninos', i::text, 'tareas', j::text, 'hecha'], p_accion->'hecha', true);
  elsif p_accion->>'tipo' = 'ahorro' and jsonb_typeof(p_accion->'monto') = 'null' then
    f.estado := jsonb_set(f.estado, array['ninos', i::text, 'ahorroPropuesto'], 'null'::jsonb, true);
  elsif p_accion->>'tipo' = 'ahorro' and jsonb_typeof(p_accion->'monto') = 'number' then
    v_monto := (p_accion->>'monto')::numeric;
    if v_monto < 0 or v_monto <> trunc(v_monto) or v_monto > coalesce((v_nino->>'sueldo')::numeric, 0) then
      return jsonb_build_object('ok', false, 'error', 'datos');
    end if;
    f.estado := jsonb_set(f.estado, array['ninos', i::text, 'ahorroPropuesto'], to_jsonb(v_monto), true);
  else
    return jsonb_build_object('ok', false, 'error', 'datos');
  end if;

  update public.ms_familia set estado = f.estado, version = version + 1, actualizado = now() where id = 1;
  return public.ms_entrar(p_perfil, p_pin);
end $$;

-- Permisos: la app (rol anon) solo puede llamar a estas seis funciones.
revoke all on function public.ms_verificar(text, text) from public, anon, authenticated;
revoke all on function public.ms_perfiles() from public;
revoke all on function public.ms_crear(text, jsonb) from public;
revoke all on function public.ms_entrar(text, text) from public;
revoke all on function public.ms_guardar(text, jsonb, int) from public;
revoke all on function public.ms_poner_pin(text, text, text) from public;
revoke all on function public.ms_nino_accion(text, text, jsonb) from public;
grant execute on function public.ms_perfiles() to anon;
grant execute on function public.ms_crear(text, jsonb) to anon;
grant execute on function public.ms_entrar(text, text) to anon;
grant execute on function public.ms_guardar(text, jsonb, int) to anon;
grant execute on function public.ms_poner_pin(text, text, text) to anon;
grant execute on function public.ms_nino_accion(text, text, jsonb) to anon;
