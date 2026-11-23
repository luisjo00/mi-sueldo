// Dónde viven los datos de "Mi Sueldo": en este dispositivo (local) o en la nube (Supabase).
// Las dos formas ofrecen las mismas funciones, así las pantallas no saben cuál se usa.
(function () {
  'use strict';

  const L = window.Logic;
  const cfg = window.MI_SUELDO_NUBE || {};
  const enNube = Boolean(cfg.url && cfg.clave);
  const CLAVE = 'mi-sueldo-v1';
  const CLAVE_PINES = 'mi-sueldo-pines';
  const CLAVE_SESION = 'mi-sueldo-sesion';

  let credencial = null; // { perfil, pin } de quien entró
  let version = 0;       // versión de los datos en la nube
  let cola = Promise.resolve();

  // ---------- Datos en este dispositivo ----------
  function leerLocal() {
    let estado = null;
    let pines = {};
    try {
      estado = JSON.parse(localStorage.getItem(CLAVE));
      pines = JSON.parse(localStorage.getItem(CLAVE_PINES)) || {};
    } catch (e) { /* datos dañados: se empieza de cero */ }
    if (estado && sacarPines(estado, pines)) escribirLocal(estado, pines);
    return { estado, pines };
  }
  function escribirLocal(estado, pines) {
    localStorage.setItem(CLAVE, JSON.stringify(estado));
    if (pines) localStorage.setItem(CLAVE_PINES, JSON.stringify(pines));
  }
  // Los PIN nunca viajan dentro de los datos. Devuelve true si encontró alguno y lo sacó.
  function sacarPines(estado, pines) {
    let habia = false;
    if (estado.config && 'adminPin' in estado.config) {
      if (estado.config.adminPin && pines) pines.admin = estado.config.adminPin;
      delete estado.config.adminPin; habia = true;
    }
    for (const n of estado.ninos || []) {
      if ('pin' in n) { if (n.pin && pines) pines[n.id] = n.pin; delete n.pin; habia = true; }
    }
    return habia;
  }
  // Datos con los que arranca la app la primera vez: lo que ya hubiera en este dispositivo o,
  // si existe, el archivo semilla.json (no se publica; ver semilla.ejemplo.json).
  async function estadoDeArranque() {
    const previo = leerLocal().estado;
    if (previo) return previo;
    let semilla = null;
    try {
      const r = await fetch('semilla.json', { cache: 'no-store' });
      if (r.ok) semilla = await r.json();
    } catch (e) { /* sin semilla */ }
    return L.estadoInicial(null, semilla);
  }

  // Un niño solo recibe su propia cuenta.
  const soloDe = (estado, id) => ({
    version: estado.version, config: estado.config,
    ninos: estado.ninos.filter((n) => n.id === id),
    movimientos: estado.movimientos.filter((m) => m.ninoId === id),
  });

  const local = {
    async perfiles() {
      const { estado, pines } = leerLocal();
      if (!estado || !pines.admin) return { configurada: false };
      return {
        configurada: true, adminNombre: estado.config.adminNombre,
        perfiles: estado.ninos.map((n) => ({ id: n.id, nombre: n.nombre, color: n.color, tienePin: Boolean(pines[n.id]) })),
      };
    },
    async crear(pin) {
      const estado = await estadoDeArranque();
      escribirLocal(estado, Object.assign(leerLocal().pines, { admin: pin }));
      return { ok: true };
    },
    async entrar(perfil, pin) {
      const { estado, pines } = leerLocal();
      if (!estado || !pines[perfil] || pines[perfil] !== pin) return { ok: false, error: 'pin' };
      if (perfil === 'admin') {
        return { ok: true, rol: 'admin', estado, conPin: Object.keys(pines).filter((k) => k !== 'admin') };
      }
      if (!estado.ninos.some((n) => n.id === perfil)) return { ok: false, error: 'pin' };
      return { ok: true, rol: 'nino', id: perfil, estado: soloDe(estado, perfil) };
    },
    async guardar(pin, estado) {
      if (leerLocal().pines.admin !== pin) return { ok: false, error: 'pin' };
      escribirLocal(estado);
      return { ok: true };
    },
    async accion(perfil, pin, accion) {
      const { estado, pines } = leerLocal();
      if (perfil === 'admin' || !estado || !pines[perfil] || pines[perfil] !== pin) return { ok: false, error: 'pin' };
      if (!L.accionNino(estado, perfil, accion)) return { ok: false, error: 'datos' };
      escribirLocal(estado);
      return local.entrar(perfil, pin);
    },
    async ponerPin(adminPin, perfil, nuevo) {
      const { estado, pines } = leerLocal();
      if (pines.admin !== adminPin) return { ok: false, error: 'pin' };
      pines[perfil] = nuevo;
      escribirLocal(estado, pines);
      return { ok: true };
    },
  };

  // ---------- Datos en la nube ----------
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

  const nube = {
    perfiles: () => rpc('ms_perfiles'),
    async crear(pin) {
      return rpc('ms_crear', { p_pin: pin, p_estado: await estadoDeArranque() });
    },
    async entrar(perfil, pin) {
      const r = await rpc('ms_entrar', { p_perfil: perfil, p_pin: pin });
      if (r.ok) version = r.version;
      return r;
    },
    async guardar(pin, estado) {
      const r = await rpc('ms_guardar', { p_pin: pin, p_estado: estado, p_version: version });
      if (r.ok) version = r.version;
      return r;
    },
    async accion(perfil, pin, accion) {
      const r = await rpc('ms_nino_accion', { p_perfil: perfil, p_pin: pin, p_accion: accion });
      if (r.ok) version = r.version;
      return r;
    },
    ponerPin: (adminPin, perfil, nuevo) =>
      rpc('ms_poner_pin', { p_admin_pin: adminPin, p_perfil: perfil, p_nuevo: nuevo }),
  };

  const fondo = enNube ? nube : local;

  // ---------- Lo que usan las pantallas ----------
  function recordar(c) {
    credencial = c;
    if (c) sessionStorage.setItem(CLAVE_SESION, JSON.stringify(c));
    else sessionStorage.removeItem(CLAVE_SESION);
  }

  async function entrar(perfil, pin) {
    const r = await fondo.entrar(perfil, pin);
    if (r.ok) recordar({ perfil, pin });
    return r;
  }

  window.Store = {
    enNube,
    perfiles: () => fondo.perfiles(),
    entrar,
    async crear(pin) {
      const r = await fondo.crear(pin);
      return r.ok ? entrar('admin', pin) : r;
    },
    // Vuelve a entrar con la sesión abierta en esta pestaña (al recargar la página).
    async reanudar() {
      let c = null;
      try { c = JSON.parse(sessionStorage.getItem(CLAVE_SESION)); } catch (e) { /* sin sesión */ }
      if (!c || !c.perfil || !c.pin) return null;
      const r = await entrar(c.perfil, c.pin);
      if (!r.ok) recordar(null);
      return r;
    },
    // Guarda en orden: cada guardado espera al anterior. Falla con Error('version') si otro
    // dispositivo cambió los datos antes.
    guardar(estado) {
      const paso = cola.then(async () => {
        if (!credencial || credencial.perfil !== 'admin') throw new Error('pin');
        sacarPines(estado);
        const r = await fondo.guardar(credencial.pin, estado);
        if (!r.ok) throw new Error(r.error);
      });
      cola = paso.catch(() => {});
      return paso;
    },
    // Un niño cambia algo de su propia cuenta (marcar una tarea, proponer su ahorro). En orden, como guardar.
    // Devuelve su cuenta ya actualizada.
    accion(accion) {
      const paso = cola.then(async () => {
        if (!credencial || credencial.perfil === 'admin') throw new Error('pin');
        const r = await fondo.accion(credencial.perfil, credencial.pin, accion);
        if (!r.ok) throw new Error(r.error);
        return r;
      });
      cola = paso.catch(() => {});
      return paso;
    },
    async ponerPin(perfil, nuevo) {
      if (!credencial || credencial.perfil !== 'admin') return { ok: false, error: 'pin' };
      const r = await fondo.ponerPin(credencial.pin, perfil, nuevo);
      if (r.ok && perfil === 'admin') recordar({ perfil: 'admin', pin: nuevo });
      return r;
    },
    salir() { recordar(null); version = 0; },
  };
})();
