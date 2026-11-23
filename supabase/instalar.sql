-- Mi Sueldo · instalación en Supabase.
-- Pégalo completo en SQL Editor y pulsa Run. Se puede volver a ejecutar sin perder datos.
--
-- Cómo queda protegido:
--   * Nadie lee ni escribe las tablas directamente (RLS activo y sin permisos). Todo pasa por las
--     funciones ms_* de abajo.
--   * Dispositivos de confianza: un dispositivo nuevo debe escribir una vez el código de familia.
--     Sin eso no ve los nombres ni puede probar ningún PIN.
--   * El PIN solo viaja al entrar. Después se usa un token de sesión al azar, del que aquí solo se
--     guarda su huella: el del administrador vence a los 30 minutos sin uso (12 horas como máximo);
--     el de un niño, a los 30 días sin uso.
--   * Los PIN y el código se guardan cifrados (bcrypt). Tras 5 intentos fallidos el perfil se bloquea
--     15 minutos; si vuelve a pasar, 1 hora; después, 4 horas cada vez.
--   * El PIN del administrador tiene 6 números; los de los niños, de 4 a 6.
--   * Una copia diaria de los datos queda en ms_historial (90 días).
--
-- Si el administrador queda bloqueado o olvida su PIN (ejecutar aquí, en SQL Editor):
--   desbloquear:      update public.ms_pin set fallos = 0, bloqueos = 0, bloqueado_hasta = null where perfil = 'admin';
--   poner PIN nuevo:  update public.ms_pin set hash = extensions.crypt('123456', extensions.gen_salt('bf')),
--                       fallos = 0, bloqueos = 0, bloqueado_hasta = null where perfil = 'admin';
--   quitar el código de familia:  delete from public.ms_pin where perfil = '_codigo';

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- Tablas
create table if not exists public.ms_familia (
  id int primary key default 1 check (id = 1),          -- una sola familia por proyecto
  estado jsonb not null,
  version int not null default 1,
  actualizado timestamptz not null default now()
);

create table if not exists public.ms_pin (
  perfil text primary key,                               -- 'admin', el id del niño o '_codigo' (código de familia)
  hash text not null,
  fallos int not null default 0,
  bloqueado_hasta timestamptz
);
alter table public.ms_pin add column if not exists bloqueos int not null default 0;  -- bloqueos seguidos

create table if not exists public.ms_dispositivo (       -- dispositivos de confianza
  id text primary key,                                   -- huella (sha256) del token del dispositivo
  creado timestamptz not null default now()
);

create table if not exists public.ms_sesion (
  id text primary key,                                   -- huella (sha256) del token de sesión
  perfil text not null,
  limitada boolean not null default false,               -- solo sirve para cambiar un PIN débil
  creada timestamptz not null default now(),
  usada timestamptz not null default now()
);

create table if not exists public.ms_historial (         -- copias diarias de los datos
  id bigint generated always as identity primary key,
  creado timestamptz not null default now(),
  version int not null,
  estado jsonb not null
);

alter table public.ms_familia enable row level security;
alter table public.ms_pin enable row level security;
alter table public.ms_dispositivo enable row level security;
alter table public.ms_sesion enable row level security;
alter table public.ms_historial enable row level security;
revoke all on public.ms_familia, public.ms_pin, public.ms_dispositivo, public.ms_sesion, public.ms_historial
  from anon, authenticated;

-- Versiones anteriores de las funciones (pedían el PIN en cada llamada): se retiran.
drop function if exists public.ms_perfiles();
drop function if exists public.ms_entrar(text, text);
drop function if exists public.ms_guardar(text, jsonb, int);
drop function if exists public.ms_poner_pin(text, text, text);
drop function if exists public.ms_nino_accion(text, text, jsonb);

-- ---------------------------------------------------------------- Piezas internas (la app no puede llamarlas)
create or replace function public.ms_huella(p text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(digest(coalesce(p, ''), 'sha256'), 'hex');
$$;

create or replace function public.ms_token() returns text
language sql volatile set search_path = public, extensions as $$
  select encode(gen_random_bytes(32), 'hex');
$$;

-- Comprueba un PIN (o el código de familia) y lleva la cuenta de intentos. Devuelve 'ok', 'pin' o 'bloqueado'.
create or replace function public.ms_verificar(p_perfil text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare r public.ms_pin;
begin
  select * into r from public.ms_pin where perfil = p_perfil for update;
  if not found or p_pin is null then return 'pin'; end if;
  if r.bloqueado_hasta is not null and r.bloqueado_hasta > now() then return 'bloqueado'; end if;
  if r.hash = crypt(p_pin, r.hash) then
    update public.ms_pin set fallos = 0, bloqueos = 0, bloqueado_hasta = null where perfil = p_perfil;
    return 'ok';
  end if;
  if r.fallos + 1 >= 5 then
    update public.ms_pin
    set fallos = 0, bloqueos = r.bloqueos + 1,
        bloqueado_hasta = now() + least(interval '15 minutes' * power(4, r.bloqueos), interval '4 hours')
    where perfil = p_perfil;
  else
    update public.ms_pin set fallos = r.fallos + 1 where perfil = p_perfil;
  end if;
  return 'pin';
end $$;

-- Minutos que le faltan a un perfil bloqueado.
create or replace function public.ms_minutos_bloqueo(p_perfil text) returns int
language sql stable security definer set search_path = public, extensions as $$
  select greatest(1, ceil(extract(epoch from (bloqueado_hasta - now())) / 60))::int
  from public.ms_pin where perfil = p_perfil and bloqueado_hasta > now();
$$;

create or replace function public.ms_codigo_puesto() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.ms_pin where perfil = '_codigo');
$$;

create or replace function public.ms_dispositivo_ok(p_dispositivo text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select p_dispositivo is not null
     and exists (select 1 from public.ms_dispositivo where id = public.ms_huella(p_dispositivo));
$$;

create or replace function public.ms_dispositivo_nuevo() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text := public.ms_token();
begin
  insert into public.ms_dispositivo (id) values (public.ms_huella(t));
  -- Tope de tamaño: se conservan los 500 más recientes.
  delete from public.ms_dispositivo
  where id in (select id from public.ms_dispositivo order by creado desc offset 500);
  return t;
end $$;

create or replace function public.ms_sesion_nueva(p_perfil text, p_limitada boolean) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text := public.ms_token();
begin
  delete from public.ms_sesion where usada < now() - interval '30 days';
  insert into public.ms_sesion (id, perfil, limitada) values (public.ms_huella(t), p_perfil, p_limitada);
  return t;
end $$;

-- De quién es una sesión vigente (null si no existe o venció). Renueva su última vez de uso.
create or replace function public.ms_sesion_perfil(p_token text, p_admitir_limitada boolean default false) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s public.ms_sesion;
begin
  if p_token is null then return null; end if;
  select * into s from public.ms_sesion where id = public.ms_huella(p_token) for update;
  if not found then return null; end if;
  if (s.perfil = 'admin' and (s.usada < now() - interval '30 minutes' or s.creada < now() - interval '12 hours'))
     or s.usada < now() - interval '30 days' then
    delete from public.ms_sesion where id = s.id;
    return null;
  end if;
  if s.limitada and not coalesce(p_admitir_limitada, false) then return null; end if;
  update public.ms_sesion set usada = now() where id = s.id;
  return s.perfil;
end $$;

-- Lo que recibe cada perfil: el administrador, todo; un niño, solo su cuenta.
create or replace function public.ms_estado_de(p_perfil text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  f public.ms_familia;
  v_nino jsonb;
begin
  select * into f from public.ms_familia where id = 1;
  if p_perfil = 'admin' then
    return jsonb_build_object('ok', true, 'rol', 'admin', 'estado', f.estado, 'version', f.version,
      'tieneCodigo', public.ms_codigo_puesto(),
      'conPin', coalesce((select jsonb_agg(perfil) from public.ms_pin where perfil not in ('admin', '_codigo')), '[]'::jsonb));
  end if;
  select n into v_nino from jsonb_array_elements(f.estado->'ninos') n where n->>'id' = p_perfil;
  if v_nino is null then return jsonb_build_object('ok', false, 'error', 'sesion'); end if;
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

-- Guarda una copia de los datos actuales si la última tiene más de 20 horas.
create or replace function public.ms_respaldar() returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.ms_historial where creado > now() - interval '20 hours') then
    insert into public.ms_historial (version, estado) select version, estado from public.ms_familia where id = 1;
    delete from public.ms_historial where creado < now() - interval '90 days';
  end if;
end $$;

-- ---------------------------------------------------------------- Lo que la app puede llamar
-- Registrar este dispositivo como de confianza. Sin código de familia definido, es libre.
create or replace function public.ms_dispositivo(p_codigo text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  if public.ms_codigo_puesto() then
    if coalesce(btrim(p_codigo), '') = '' then return jsonb_build_object('ok', false, 'error', 'codigo'); end if;
    v := public.ms_verificar('_codigo', lower(btrim(p_codigo)));
    if v = 'bloqueado' then
      return jsonb_build_object('ok', false, 'error', 'bloqueado', 'minutos', public.ms_minutos_bloqueo('_codigo'));
    elsif v <> 'ok' then
      return jsonb_build_object('ok', false, 'error', 'codigo');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'dispositivo', public.ms_dispositivo_nuevo());
end $$;

-- Lo que se ve antes de entrar. Los nombres, solo en un dispositivo de confianza.
create or replace function public.ms_perfiles(p_dispositivo text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare f public.ms_familia;
begin
  select * into f from public.ms_familia where id = 1;
  if not found then return jsonb_build_object('configurada', false); end if;
  if public.ms_codigo_puesto() and not public.ms_dispositivo_ok(p_dispositivo) then
    return jsonb_build_object('configurada', true, 'requiereCodigo', true);
  end if;
  return jsonb_build_object(
    'configurada', true,
    'adminNombre', f.estado->'config'->>'adminNombre',
    'perfiles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n->>'id', 'nombre', n->>'nombre', 'color', n->>'color',
        'tienePin', exists (select 1 from public.ms_pin p where p.perfil = n->>'id')) order by ord)
      from jsonb_array_elements(f.estado->'ninos') with ordinality as t(n, ord)), '[]'::jsonb));
end $$;

-- Primera vez: crea la familia con el PIN del administrador. Solo funciona si aún no existe.
create or replace function public.ms_crear(p_pin text, p_estado jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.ms_familia) then
    return jsonb_build_object('ok', false, 'error', 'existe');
  end if;
  if p_pin is null or p_pin !~ '^\d{6}$' then
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

-- Entrar con PIN desde un dispositivo de confianza. Devuelve un token de sesión.
create or replace function public.ms_entrar(p_dispositivo text, p_perfil text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v text;
  t text;
  v_limitada boolean;
begin
  if p_perfil is null or p_perfil = '_codigo' then return jsonb_build_object('ok', false, 'error', 'pin'); end if;
  if public.ms_codigo_puesto() and not public.ms_dispositivo_ok(p_dispositivo) then
    return jsonb_build_object('ok', false, 'error', 'dispositivo');
  end if;
  v := public.ms_verificar(p_perfil, p_pin);
  if v = 'bloqueado' then
    return jsonb_build_object('ok', false, 'error', 'bloqueado', 'minutos', public.ms_minutos_bloqueo(p_perfil));
  elsif v <> 'ok' then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  if p_perfil <> 'admin' and not exists (
    select 1 from public.ms_familia f, jsonb_array_elements(f.estado->'ninos') n where n->>'id' = p_perfil) then
    return jsonb_build_object('ok', false, 'error', 'pin');
  end if;
  -- Un PIN de administrador de menos de 6 números (de antes) solo deja cambiarlo.
  v_limitada := p_perfil = 'admin' and p_pin !~ '^\d{6}$';
  t := public.ms_sesion_nueva(p_perfil, v_limitada);
  if v_limitada then
    return jsonb_build_object('ok', true, 'rol', 'admin', 'token', t, 'debePin', true);
  end if;
  return public.ms_estado_de(p_perfil) || jsonb_build_object('token', t);
end $$;

-- Leer los datos con una sesión abierta (al recargar la página o volver a la app).
create or replace function public.ms_leer(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_perfil text := public.ms_sesion_perfil(p_token);
begin
  if v_perfil is null then return jsonb_build_object('ok', false, 'error', 'sesion'); end if;
  return public.ms_estado_de(v_perfil);
end $$;

-- Guardar (solo administrador). p_version evita pisar cambios hechos desde otro dispositivo.
create or replace function public.ms_guardar(p_token text, p_estado jsonb, p_version int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_actual int;
begin
  if public.ms_sesion_perfil(p_token) is distinct from 'admin' then
    return jsonb_build_object('ok', false, 'error', 'sesion');
  end if;
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
  perform public.ms_respaldar();
  update public.ms_familia set estado = p_estado, version = version + 1, actualizado = now() where id = 1;
  return jsonb_build_object('ok', true, 'version', v_actual + 1);
end $$;

-- Lo único que un niño puede cambiar, y solo en su propia cuenta: marcar una tarea como hecha,
-- proponer cuánto ahorrar en su próximo pago o pedir un retiro (que el administrador aprueba o rechaza).
-- Devuelve su cuenta actualizada.
--   p_accion: {"tipo":"tarea","tareaId":"...","hecha":true}  |  {"tipo":"ahorro","monto":15000}
--             |  {"tipo":"retiro","monto":5000,"motivo":"..."}     (monto null = quitar o cancelar)
create or replace function public.ms_nino_accion(p_token text, p_accion jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_perfil text := public.ms_sesion_perfil(p_token);
  f public.ms_familia;
  i int;
  j int;
  v_nino jsonb;
  v_monto numeric;
  v_saldo numeric;
begin
  if v_perfil is null or v_perfil = 'admin' then return jsonb_build_object('ok', false, 'error', 'sesion'); end if;
  select * into f from public.ms_familia where id = 1 for update;
  select (ord - 1)::int, n into i, v_nino
  from jsonb_array_elements(f.estado->'ninos') with ordinality as t(n, ord) where n->>'id' = v_perfil;
  if i is null then return jsonb_build_object('ok', false, 'error', 'sesion'); end if;

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
  elsif p_accion->>'tipo' = 'retiro' and jsonb_typeof(p_accion->'monto') = 'null' then
    f.estado := jsonb_set(f.estado, array['ninos', i::text, 'retiroSolicitado'], 'null'::jsonb, true);
  elsif p_accion->>'tipo' = 'retiro' and jsonb_typeof(p_accion->'monto') = 'number' then
    v_monto := (p_accion->>'monto')::numeric;
    -- Lo que tiene ahorrado: igual que resumen() en js/logic.js.
    select coalesce(sum(case m->>'tipo'
        when 'pago' then (m->>'ahorro')::numeric
        when 'retiro' then -(m->>'monto')::numeric
        else (m->>'monto')::numeric end), 0) into v_saldo
    from jsonb_array_elements(f.estado->'movimientos') m where m->>'ninoId' = v_perfil;
    if v_monto <= 0 or v_monto <> trunc(v_monto) or v_monto > v_saldo
       or (p_accion ? 'motivo' and jsonb_typeof(p_accion->'motivo') not in ('string', 'null'))
       or length(coalesce(p_accion->>'motivo', '')) > 120 then
      return jsonb_build_object('ok', false, 'error', 'datos');
    end if;
    f.estado := jsonb_set(f.estado, array['ninos', i::text, 'retiroSolicitado'], jsonb_build_object(
      'monto', v_monto, 'motivo', coalesce(p_accion->>'motivo', ''),
      'fecha', to_char(now() at time zone 'America/Bogota', 'YYYY-MM-DD')), true);
  else
    return jsonb_build_object('ok', false, 'error', 'datos');
  end if;

  perform public.ms_respaldar();
  update public.ms_familia set estado = f.estado, version = version + 1, actualizado = now() where id = 1;
  return public.ms_estado_de(v_perfil);
end $$;

-- Crear o cambiar un PIN (solo administrador).
--   De un niño (p_perfil = su id): 4 a 6 números. Cierra las sesiones de ese niño.
--   El suyo (p_perfil = 'admin'): 6 números y hay que dar el PIN actual en p_actual. Cierra todas sus sesiones.
create or replace function public.ms_poner_pin(p_token text, p_perfil text, p_nuevo text, p_actual text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v text;
  -- La sesión limitada (PIN débil) solo sirve para cambiar el PIN propio.
  v_sesion text := public.ms_sesion_perfil(p_token, coalesce(p_perfil = 'admin', false));
begin
  if v_sesion is distinct from 'admin' then return jsonb_build_object('ok', false, 'error', 'sesion'); end if;
  if p_perfil = 'admin' then
    if p_nuevo is null or p_nuevo !~ '^\d{6}$' then return jsonb_build_object('ok', false, 'error', 'formato'); end if;
    v := public.ms_verificar('admin', p_actual);
    if v = 'bloqueado' then
      return jsonb_build_object('ok', false, 'error', 'bloqueado', 'minutos', public.ms_minutos_bloqueo('admin'));
    elsif v <> 'ok' then
      return jsonb_build_object('ok', false, 'error', 'pin');
    end if;
    update public.ms_pin set hash = crypt(p_nuevo, gen_salt('bf')), fallos = 0, bloqueos = 0, bloqueado_hasta = null
    where perfil = 'admin';
    delete from public.ms_sesion where perfil = 'admin';
    return jsonb_build_object('ok', true);
  end if;
  if p_nuevo is null or p_nuevo !~ '^\d{4,6}$' then return jsonb_build_object('ok', false, 'error', 'formato'); end if;
  if p_perfil is null or not exists (
    select 1 from public.ms_familia f, jsonb_array_elements(f.estado->'ninos') n where n->>'id' = p_perfil) then
    return jsonb_build_object('ok', false, 'error', 'perfil');
  end if;
  insert into public.ms_pin (perfil, hash) values (p_perfil, crypt(p_nuevo, gen_salt('bf')))
  on conflict (perfil) do update set hash = excluded.hash, fallos = 0, bloqueos = 0, bloqueado_hasta = null;
  delete from public.ms_sesion where perfil = p_perfil;
  return jsonb_build_object('ok', true);
end $$;

-- Definir o cambiar el código de familia (solo administrador): 6 a 20 letras o números, sin distinguir
-- mayúsculas. Olvida todos los dispositivos y cierra las demás sesiones; devuelve un dispositivo nuevo
-- de confianza para quien lo cambia.
create or replace function public.ms_poner_codigo(p_token text, p_codigo text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_codigo text := lower(btrim(coalesce(p_codigo, '')));
begin
  if public.ms_sesion_perfil(p_token) is distinct from 'admin' then
    return jsonb_build_object('ok', false, 'error', 'sesion');
  end if;
  if v_codigo !~ '^[a-z0-9]{6,20}$' then return jsonb_build_object('ok', false, 'error', 'formato'); end if;
  insert into public.ms_pin (perfil, hash) values ('_codigo', crypt(v_codigo, gen_salt('bf')))
  on conflict (perfil) do update set hash = excluded.hash, fallos = 0, bloqueos = 0, bloqueado_hasta = null;
  delete from public.ms_dispositivo;
  delete from public.ms_sesion where id <> public.ms_huella(p_token);
  return jsonb_build_object('ok', true, 'dispositivo', public.ms_dispositivo_nuevo());
end $$;

-- Cerrar la sesión propia.
create or replace function public.ms_salir(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.ms_sesion where id = public.ms_huella(p_token);
  return jsonb_build_object('ok', true);
end $$;

-- Cerrar todas las demás sesiones y olvidar todos los dispositivos (solo administrador).
create or replace function public.ms_cerrar_todo(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.ms_sesion_perfil(p_token) is distinct from 'admin' then
    return jsonb_build_object('ok', false, 'error', 'sesion');
  end if;
  delete from public.ms_sesion where id <> public.ms_huella(p_token);
  delete from public.ms_dispositivo;
  return jsonb_build_object('ok', true, 'dispositivo', public.ms_dispositivo_nuevo());
end $$;

-- ---------------------------------------------------------------- Permisos
-- Primero se le quita todo a todos en cada función ms_*; después la app (rol anon) recibe solo las suyas.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as firma from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'ms\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.firma);
  end loop;
end $$;

grant execute on function public.ms_dispositivo(text) to anon;
grant execute on function public.ms_perfiles(text) to anon;
grant execute on function public.ms_crear(text, jsonb) to anon;
grant execute on function public.ms_entrar(text, text, text) to anon;
grant execute on function public.ms_leer(text) to anon;
grant execute on function public.ms_guardar(text, jsonb, int) to anon;
grant execute on function public.ms_nino_accion(text, jsonb) to anon;
grant execute on function public.ms_poner_pin(text, text, text, text) to anon;
grant execute on function public.ms_poner_codigo(text, text) to anon;
grant execute on function public.ms_salir(text) to anon;
grant execute on function public.ms_cerrar_todo(text) to anon;

notify pgrst, 'reload schema';
