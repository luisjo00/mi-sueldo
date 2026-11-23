// Conexión de "Mi Sueldo" con la nube (Supabase). Las reglas viven en supabase/instalar.sql.
//
// En este dispositivo se guardan dos cosas, nunca un PIN:
//   * el token del dispositivo de confianza (se obtiene una vez, con el código de familia);
//   * el token de la sesión abierta: el del administrador solo dura mientras la pestaña esté abierta
//     (sessionStorage); el de un niño se conserva (localStorage) para que no escriba su PIN cada vez.
(function () {
  'use strict';

  const L = window.Logic;
  const cfg = window.MI_SUELDO_NUBE || {};
  const CLAVE_DISPOSITIVO = 'mi-sueldo-dispositivo';
  const CLAVE_SESION = 'mi-sueldo-sesion';

  let token = null;   // sesión abierta
  let rol = null;     // 'admin' o 'nino'
  let version = 0;    // versión de los datos en la nube
  let cola = Promise.resolve();

  async function rpc(funcion, datos) {
    const cabeceras = { 'Content-Type': 'application/json', apikey: cfg.clave };
    // Las claves antiguas (JWT) también van como Bearer; las nuevas "sb_publishable_" solo en apikey.
    if (cfg.clave.startsWith('eyJ')) cabeceras.Authorization = 'Bearer ' + cfg.clave;
    const r = await fetch(`${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/${funcion}`, {
      method: 'POST', headers: cabeceras, body: JSON.stringify(datos || {}),
    });
    if (!r.ok) throw new Error('nube ' + r.status);
    return r.json();
  }

  const dispositivo = () => localStorage.getItem(CLAVE_DISPOSITIVO);
  const ponerDispositivo = (d) => localStorage.setItem(CLAVE_DISPOSITIVO, d);

  function recordar(nuevoToken, nuevoRol) {
    token = nuevoToken; rol = nuevoToken ? nuevoRol : null;
    sessionStorage.removeItem(CLAVE_SESION);
    localStorage.removeItem(CLAVE_SESION);
    if (nuevoToken) (nuevoRol === 'admin' ? sessionStorage : localStorage).setItem(CLAVE_SESION, nuevoToken);
  }

  // Datos con los que arranca una instalación nueva: semilla.json si existe (no se publica).
  async function estadoDeArranque() {
    let semilla = null;
    try {
      const r = await fetch('semilla.json', { cache: 'no-store' });
      if (r.ok) semilla = await r.json();
    } catch (e) { /* sin semilla */ }
    return L.estadoInicial(null, semilla);
  }

  // Lo que se hace en orden, uno tras otro (guardar y las acciones de un niño).
  function enCola(tarea) {
    const paso = cola.then(tarea);
    cola = paso.catch(() => {});
    return paso;
  }

  async function entrar(perfil, pin) {
    const r = await rpc('ms_entrar', { p_dispositivo: dispositivo(), p_perfil: perfil, p_pin: pin });
    if (r.ok) {
      recordar(r.token, r.rol);
      version = r.version || 0;
      delete r.token;
    }
    return r;
  }

  window.Store = {
    configurada: Boolean(cfg.url && cfg.clave),

    // Portada: { configurada, requiereCodigo } o { configurada, adminNombre, perfiles }.
    async perfiles() {
      if (!dispositivo()) {
        const d = await rpc('ms_dispositivo', { p_codigo: null }); // solo funciona si aún no hay código de familia
        if (d.ok) ponerDispositivo(d.dispositivo);
      }
      return rpc('ms_perfiles', { p_dispositivo: dispositivo() });
    },
    // Registrar este dispositivo con el código de familia.
    async conCodigo(codigo) {
      const r = await rpc('ms_dispositivo', { p_codigo: codigo });
      if (r.ok) ponerDispositivo(r.dispositivo);
      return r;
    },
    async crear(pin) {
      const r = await rpc('ms_crear', { p_pin: pin, p_estado: await estadoDeArranque() });
      return r.ok ? entrar('admin', pin) : r;
    },
    entrar,
    // Retoma la sesión guardada en este dispositivo (al recargar la página o volver a la app).
    async reanudar() {
      const guardado = sessionStorage.getItem(CLAVE_SESION) || localStorage.getItem(CLAVE_SESION);
      if (!guardado) return null;
      const r = await rpc('ms_leer', { p_token: guardado });
      if (r.ok) { token = guardado; rol = r.rol; version = r.version; } else recordar(null);
      return r;
    },
    // Guarda todo (administrador). Falla con Error('version') si otro dispositivo cambió los datos
    // antes, o Error('sesion') si la sesión venció.
    guardar(estado) {
      return enCola(async () => {
        if (rol !== 'admin') throw new Error('sesion');
        const r = await rpc('ms_guardar', { p_token: token, p_estado: estado, p_version: version });
        if (!r.ok) throw new Error(r.error);
        version = r.version;
      });
    },
    // Un niño cambia algo de su propia cuenta. Devuelve su cuenta ya actualizada.
    accion(accion) {
      return enCola(async () => {
        if (rol !== 'nino') throw new Error('sesion');
        const r = await rpc('ms_nino_accion', { p_token: token, p_accion: accion });
        if (!r.ok) throw new Error(r.error);
        version = r.version;
        return r;
      });
    },
    // PIN de un niño (perfil = su id) o del administrador ('admin', que exige el PIN actual).
    // Al cambiar el del administrador se cierran todas sus sesiones: hay que volver a entrar.
    async ponerPin(perfil, nuevo, actual) {
      const r = await rpc('ms_poner_pin', { p_token: token, p_perfil: perfil, p_nuevo: nuevo, p_actual: actual || null });
      if (r.ok && perfil === 'admin') recordar(null);
      return r;
    },
    // Define el código de familia. Los demás dispositivos tendrán que escribirlo de nuevo.
    async ponerCodigo(codigo) {
      const r = await rpc('ms_poner_codigo', { p_token: token, p_codigo: codigo });
      if (r.ok) ponerDispositivo(r.dispositivo);
      return r;
    },
    async cerrarTodo() {
      const r = await rpc('ms_cerrar_todo', { p_token: token });
      if (r.ok) ponerDispositivo(r.dispositivo);
      return r;
    },
    salir() {
      const t = token;
      recordar(null); version = 0;
      if (t) rpc('ms_salir', { p_token: t }).catch(() => {});
    },
  };
})();
