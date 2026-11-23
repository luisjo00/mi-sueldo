// Pantallas de "Mi Sueldo". Dónde se guardan los datos lo decide js/store.js.
(function () {
  'use strict';

  const L = window.Logic;
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal');

  // ---------- Datos ----------
  const S = window.Store;
  let state = null;   // los datos de quien entró (el administrador los ve todos; un niño, solo los suyos)
  let conPin = [];    // ids de los niños que ya tienen PIN (solo lo sabe el administrador)
  const ui = {
    cargando: true, fallo: false, portada: null, sesion: null,
    pantalla: 'inicio', ninoId: null, tab: 'movimientos', perfil: null, error: '',
  };
  let alConfirmar = null;

  function guardar() {
    S.guardar(state).catch((e) => {
      if (e.message === 'version') {
        aviso('Los datos cambiaron desde otro dispositivo. Ya se actualizaron: repite tu último cambio.');
        arrancar();
      } else if (e.message === 'pin' || e.message === 'bloqueado') {
        aviso('Tu sesión ya no es válida. Vuelve a entrar.');
        acciones.salir();
      } else {
        aviso('No se pudo guardar. Revisa tu conexión a internet.');
      }
    });
  }

  function aplicarEntrada(r) {
    ui.sesion = { rol: r.rol, id: r.id };
    state = r.estado;
    conPin = r.conPin || [];
  }

  // Un niño cambia algo de su cuenta. La pantalla ya muestra el cambio; al responder el servidor se
  // toma su versión (solo cuando no quedan envíos en camino, para no pisar toques más recientes).
  let enviosNino = 0;
  function enviarAccionNino(accion) {
    enviosNino += 1;
    S.accion(accion).then((r) => {
      enviosNino -= 1;
      if (enviosNino === 0) { aplicarEntrada(r); if (!$modal.innerHTML) render(); }
    }, () => {
      enviosNino -= 1;
      aviso('No se pudo guardar. Revisa tu conexión a internet.');
      if (enviosNino === 0) arrancar();
    });
  }

  // Botón "Instalar" (el navegador avisa cuando la app se puede instalar).
  let instalar = null;
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    instalar = ev;
    if (!ui.cargando && !ui.sesion && !ui.perfil) render();
  });

  // Carga la portada (quiénes pueden entrar) y retoma la sesión abierta, si la hay.
  function arrancar() {
    ui.cargando = true; ui.fallo = false;
    render();
    return S.perfiles()
      .then((p) => { ui.portada = p; return p.configurada ? S.reanudar() : null; })
      .then((r) => { if (r && r.ok) aplicarEntrada(r); else { ui.sesion = null; state = null; } })
      .catch(() => { ui.fallo = true; })
      .then(() => { ui.cargando = false; render(); });
  }

  // ---------- Utilidades ----------
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = L.dinero;
  const esAdmin = () => Boolean(ui.sesion && ui.sesion.rol === 'admin');
  const avatar = (n, grande) =>
    `<span class="avatar${grande ? ' grande' : ''}" style="background:${esc(n.color)}">${esc(n.nombre.charAt(0))}</span>`;
  const pinValido = (p) => /^\d{4,6}$/.test(p);
  const nombreMes = (f) => new Date(f + 'T00:00').toLocaleDateString('es-CO', { month: 'long' });

  function aviso(texto) {
    const t = document.createElement('div');
    t.className = 'aviso';
    t.textContent = texto;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------- Entrada ----------
  function vistaCrearPin() {
    return `
    <main class="centro">
      <h1 class="marca">Mi Sueldo</h1>
      <p class="suave">Primero crea tu PIN de administrador. Con él entras tú; cada niño tendrá el suyo.</p>
      <form data-form="crear-pin" class="tarjeta formulario">
        <label>PIN (4 a 6 números)
          <input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" required></label>
        <label>Repite el PIN
          <input name="pin2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" required></label>
        ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
        <button class="btn primario">Crear PIN</button>
      </form>
    </main>`;
  }

  function vistaPerfiles() {
    return `
    <main class="centro">
      <h1 class="marca">Mi Sueldo</h1>
      <p class="suave">¿Quién eres?</p>
      <div class="perfiles">
        ${ui.portada.perfiles.map((n) => `
          <button class="perfil" data-a="perfil" data-id="${n.id}">${avatar(n, true)}<span>${esc(n.nombre)}</span></button>`).join('')}
        <button class="perfil" data-a="perfil" data-id="admin">
          <span class="avatar grande admin">${esc(ui.portada.adminNombre.charAt(0))}</span><span>${esc(ui.portada.adminNombre)}</span>
        </button>
      </div>
      ${instalar ? '<button class="btn" data-a="instalar">Instalar en este dispositivo</button>' : ''}
    </main>`;
  }

  function vistaPin() {
    const admin = ui.portada.adminNombre;
    const nino = ui.perfil === 'admin' ? null : ui.portada.perfiles.find((n) => n.id === ui.perfil);
    const nombre = nino ? nino.nombre : admin;
    const sinPin = nino && !nino.tienePin;
    return `
    <main class="centro">
      <h1 class="marca">Hola, ${esc(nombre)}</h1>
      ${sinPin
        ? `<p class="suave">${esc(admin)} todavía no te ha creado un PIN. Pídele que te lo cree.</p>`
        : `<form data-form="entrar" class="tarjeta formulario">
            <label>Escribe tu PIN
              <input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" autofocus required></label>
            ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
            <button class="btn primario">Entrar</button>
          </form>`}
      <button class="btn plano" data-a="volver-perfiles">← Volver</button>
    </main>`;
  }

  // ---------- Administrador: inicio ----------
  function vistaInicio() {
    const f = L.hoy();
    const total = state.ninos.reduce((s, n) => s + L.resumen(state, n.id).ahorrado, 0);
    const pendientes = state.ninos.filter(
      (n) => L.resumen(state, n.id).ahorrado > 0 && !L.interesYaAplicado(state, n.id, f));
    const c = state.config;
    return `
    <header class="barra">
      <div><h1 class="marca chica">Mi Sueldo</h1><p class="suave">Hola, ${esc(c.adminNombre)}</p></div>
      <div class="fila"><button class="btn plano" data-a="ajustes">Ajustes</button><button class="btn plano" data-a="salir">Salir</button></div>
    </header>
    <main>
      <section class="tarjeta total">
        <p class="suave">Dinero que les tienes guardado</p>
        <p class="cifra">${$(total)}</p>
      </section>
      ${state.ninos.length ? '' : '<p class="suave">Todavía no hay niños. Agrégalos en Ajustes.</p>'}
      ${state.ninos.map((n) => {
        const r = L.resumen(state, n.id);
        const vencido = n.proximoPago && n.proximoPago <= f;
        return `
        <section class="tarjeta nino" style="--color:${esc(n.color)}">
          <div class="fila entre">
            <div class="fila">${avatar(n)}<div><h2>${esc(n.nombre)}</h2>
              <p class="suave">${$(n.sueldo)} ${n.frecuencia === 'semanal' ? 'cada semana' : 'cada 4 semanas'}</p></div></div>
            <div class="derecha"><p class="suave">Ahorrado</p><p class="cifra media">${$(r.ahorrado)}</p></div>
          </div>
          <p class="proximo${vencido ? ' vencido' : ''}">${vencido ? 'Pago pendiente desde' : 'Próximo pago:'} ${esc(L.fechaCorta(n.proximoPago))}</p>
          ${n.tareas.length || Number.isFinite(n.ahorroPropuesto) ? `<p class="suave">${[
            n.tareas.length ? `Tareas hechas: ${L.hechasDe(n).length} de ${n.tareas.length}` : '',
            Number.isFinite(n.ahorroPropuesto) ? `Propone ahorrar ${$(n.ahorroPropuesto)}` : '',
          ].filter(Boolean).join(' · ')}</p>` : ''}
          <div class="fila">
            <button class="btn primario" data-a="pagar" data-id="${n.id}">Pagar</button>
            <button class="btn" data-a="ver-nino" data-id="${n.id}">Ver cuenta</button>
            <button class="btn${conPin.includes(n.id) ? ' plano' : ' falta'}" data-a="pin" data-id="${n.id}">${conPin.includes(n.id) ? 'Cambiar PIN' : 'Crear su PIN'}</button>
          </div>
          ${conPin.includes(n.id) ? '' : `<p class="suave">${esc(n.nombre)} no puede entrar hasta que le crees un PIN.</p>`}
        </section>`;
      }).join('')}
      ${c.interesActivo ? `
      <section class="tarjeta">
        <h2>Interés del mes (${esc(c.interesMensual)}%)</h2>
        ${pendientes.length
          ? `<p class="suave">Falta pagar el interés de ${esc(nombreMes(f))} a: ${pendientes.map((n) => esc(n.nombre)).join(', ')}.</p>
             <button class="btn" data-a="interes">Pagar interés de ${esc(nombreMes(f))}</button>`
          : `<p class="suave">No hay interés pendiente por pagar en ${esc(nombreMes(f))}.</p>`}
      </section>` : ''}
    </main>`;
  }

  // ---------- Cuenta de un niño (la ve el admin y, en solo lectura, el niño) ----------
  function bloqueMetas(n, r, admin) {
    const lista = n.metas.map((m) => {
      const pct = Math.min(100, Math.round((r.ahorrado / m.precio) * 100));
      const falta = m.precio - r.ahorrado;
      return `
      <div class="meta">
        <div class="fila entre"><strong>${esc(m.nombre)}</strong><span>${$(m.precio)}</span></div>
        <div class="progreso"><i style="width:${pct}%"></i></div>
        <div class="fila entre"><span class="suave">${falta > 0 ? `Te faltan ${$(falta)}` : '¡Ya la alcanzaste! 🎉'}</span>
          ${admin ? `<button class="enlace peligro" data-a="borrar-meta" data-id="${m.id}">Quitar</button>` : `<span class="suave">${pct}%</span>`}</div>
      </div>`;
    }).join('');
    return `
      ${lista || '<p class="suave">Todavía no hay metas de ahorro.</p>'}
      ${admin ? `
      <form data-form="meta" class="fila agregar">
        <input name="nombre" placeholder="Meta (ej. tenis)" required>
        <input name="precio" type="number" min="100" step="100" inputmode="numeric" placeholder="Precio" required>
        <button class="btn">Agregar</button>
      </form>` : ''}`;
  }

  function bloqueTareas(n, admin) {
    const valor = n.tareas.length ? Math.round(n.sueldo / n.tareas.length / 100) * 100 : 0;
    return `
      ${n.tareas.length
        ? `<p class="suave">${L.hechasDe(n).length} de ${n.tareas.length} hechas · cada tarea vale ${$(valor)} del sueldo. ${admin ? 'Tú también puedes marcarlas o desmarcarlas.' : 'Toca una tarea cuando la termines.'}</p>
           <ul class="lista">${n.tareas.map((t) => `
             <li class="fila entre">
               <button class="tarea${t.hecha ? ' hecha' : ''}" data-a="marcar-tarea" data-id="${t.id}" aria-pressed="${t.hecha ? 'true' : 'false'}">
                 <span class="caja">${t.hecha ? '✓' : ''}</span><span>${esc(t.nombre)}</span></button>
               ${admin ? `<button class="enlace peligro" data-a="borrar-tarea" data-id="${t.id}">Quitar</button>` : ''}</li>`).join('')}</ul>`
        : `<p class="suave">${admin ? 'Sin tareas: se paga el sueldo completo. Agrega tareas para pagar según lo cumplido.' : 'Todavía no hay tareas asignadas.'}</p>`}
      ${admin ? `
      <form data-form="tarea" class="fila agregar">
        <input name="nombre" placeholder="Nueva tarea (ej. tender la cama)" required>
        <button class="btn">Agregar</button>
      </form>` : ''}`;
  }

  // Lo que el niño va ganando esta semana y cuánto decide ahorrar.
  function bloqueProximoPago(n) {
    const c = L.calcularPago(n, L.hechasDe(n));
    const tope = n.sueldo - Math.round((n.sueldo * L.DIEZMO) / 100) * 100;
    const eligio = Number.isFinite(n.ahorroPropuesto);
    return `
      <p class="suave">${esc(L.fechaCorta(n.proximoPago))}. Así va tu pago con las tareas que llevas marcadas:</p>
      <div class="calculo">
        <div><span>Vas ganando${c.tareasTotal ? ` (${c.tareasCumplidas} de ${c.tareasTotal} tareas)` : ''}</span><b>${$(c.ganado)}</b></div>
        <div><span>Diezmo (10%)</span><b>− ${$(c.diezmo)}</b></div>
        <div><span>Ahorro</span><b>− ${$(c.ahorro)}</b></div>
        <div class="final"><span>Te queda en mano</span><b>${$(c.libre)}</b></div>
      </div>
      <form data-form="ahorro" class="formulario">
        <label>¿Cuánto quieres ahorrar en este pago?
          <input name="monto" type="number" min="0" max="${tope}" step="100" inputmode="numeric" value="${eligio ? n.ahorroPropuesto : n.ahorroSugerido}" required></label>
        <p class="suave">${eligio ? `Elegiste ahorrar ${$(n.ahorroPropuesto)}.` : 'Todavía no has elegido.'} ${esc(state.config.adminNombre)} te sugiere al menos ${$(n.ahorroSugerido)}; puedes ahorrar hasta ${$(tope)}.</p>
        ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
        <button class="btn primario">Guardar mi ahorro</button>
      </form>`;
  }

  function bloqueMovimientos(n, admin) {
    const movs = L.movimientosDe(state, n.id);
    if (!movs.length) return '<p class="suave">Todavía no hay movimientos.</p>';
    return `<ul class="lista movimientos">${movs.map((m) => {
      const e = L.efectoAhorro(m);
      return `
      <li>
        <div class="fila entre">
          <div><strong>${esc(L.nombreTipo(m))}</strong><p class="suave">${esc(L.fechaCorta(m.fecha))}</p></div>
          <div class="derecha"><span class="monto ${e < 0 ? 'menos' : 'mas'}">${e < 0 ? '−' : '+'}${$(Math.abs(e))}</span><p class="suave">al ahorro</p></div>
        </div>
        ${m.tipo === 'pago' ? `<p class="detalle">Ganó ${$(m.ganado)} · diezmo ${$(m.diezmo)} · en mano ${$(m.libre)}</p>` : ''}
        ${m.nota ? `<p class="detalle">${esc(m.nota)}</p>` : ''}
        <div class="fila">
          ${m.tipo === 'pago' ? `<button class="enlace" data-a="comprobante" data-id="${m.id}">Ver comprobante</button>` : ''}
          ${admin ? `<button class="enlace peligro" data-a="borrar-mov" data-id="${m.id}">Eliminar</button>` : ''}
        </div>
      </li>`;
    }).join('')}</ul>`;
  }

  function bloqueDatos(n) {
    return `
    <form data-form="datos" class="formulario">
      <label>Nombre<input name="nombre" value="${esc(n.nombre)}" required></label>
      <label>Sueldo<input name="sueldo" type="number" min="0" step="100" inputmode="numeric" value="${n.sueldo}" required></label>
      <label>Se le paga
        <select name="frecuencia">
          <option value="semanal"${n.frecuencia === 'semanal' ? ' selected' : ''}>Cada semana</option>
          <option value="cuatrisemanal"${n.frecuencia === 'cuatrisemanal' ? ' selected' : ''}>Cada 4 semanas</option>
        </select></label>
      <label>Ahorro sugerido por pago<input name="ahorroSugerido" type="number" min="0" step="100" inputmode="numeric" value="${n.ahorroSugerido}" required></label>
      <label>Próximo pago<input name="proximoPago" type="date" value="${esc(n.proximoPago)}" required></label>
      <label>PIN de ${esc(n.nombre)} (${conPin.includes(n.id) ? 'ya tiene; déjalo vacío para no cambiarlo' : 'todavía no tiene'})
        <input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="4 a 6 números"></label>
      ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
      <button class="btn primario">Guardar</button>
    </form>`;
  }

  function vistaNino(id, admin) {
    const n = L.buscarNino(state, id);
    if (!n) { ui.pantalla = 'inicio'; return vistaInicio(); }
    const r = L.resumen(state, id);
    const tabs = [['movimientos', 'Movimientos'], ['tareas', 'Tareas'], ['metas', 'Metas'], ['datos', 'Datos']];
    const contenido = { movimientos: bloqueMovimientos, tareas: (x) => bloqueTareas(x, true), metas: (x) => bloqueMetas(x, r, true), datos: bloqueDatos };
    return `
    <header class="barra">
      <div class="fila">${avatar(n)}<div><h1 class="marca chica">${esc(n.nombre)}</h1>
        <p class="suave">Próximo pago: ${esc(L.fechaCorta(n.proximoPago))}</p></div></div>
      ${admin ? '<button class="btn plano" data-a="inicio">← Inicio</button>' : '<button class="btn plano" data-a="salir">Salir</button>'}
    </header>
    <main style="--color:${esc(n.color)}">
      <section class="tarjeta heroe">
        <p>${admin ? 'Tiene ahorrado' : 'Tienes ahorrado'}</p>
        <p class="cifra">${$(r.ahorrado)}</p>
      </section>
      <section class="datos">
        <div><span>Ganado en total</span><b>${$(r.ganado)}</b></div>
        <div><span>Diezmado</span><b>${$(r.diezmado)}</b></div>
        <div><span>Recibido en mano</span><b>${$(r.enMano)}</b></div>
        <div><span>Intereses ganados</span><b>${$(r.intereses)}</b></div>
        <div><span>Retirado del ahorro</span><b>${$(r.retirado)}</b></div>
        <div><span>Pagos recibidos</span><b>${r.pagos}</b></div>
      </section>
      ${admin ? `
      <div class="fila acciones">
        <button class="btn primario" data-a="pagar" data-id="${n.id}">Pagar</button>
        <button class="btn" data-a="retiro" data-id="${n.id}">Retiro</button>
        <button class="btn" data-a="abono" data-id="${n.id}">Abono extra</button>
      </div>
      <nav class="tabs">${tabs.map(([k, t]) => `<button class="${ui.tab === k ? 'activo' : ''}" data-a="tab" data-id="${k}">${t}</button>`).join('')}</nav>
      <section class="tarjeta">${contenido[ui.tab](n, true)}</section>`
      : `
      <section class="tarjeta"><h2>Mis tareas</h2>${bloqueTareas(n, false)}</section>
      <section class="tarjeta"><h2>Mi próximo pago</h2>${bloqueProximoPago(n)}</section>
      <section class="tarjeta"><h2>Mis metas</h2>${bloqueMetas(n, r, false)}</section>
      <section class="tarjeta"><h2>Mis movimientos</h2>${bloqueMovimientos(n, false)}</section>`}
    </main>`;
  }

  // ---------- Ajustes ----------
  function vistaAjustes() {
    const c = state.config;
    return `
    <header class="barra"><h1 class="marca chica">Ajustes</h1><button class="btn plano" data-a="inicio">← Inicio</button></header>
    <main>
      <form data-form="ajustes" class="tarjeta formulario">
        <label>Tu nombre<input name="adminNombre" value="${esc(c.adminNombre)}" required></label>
        <label class="casilla"><input name="interesActivo" type="checkbox"${c.interesActivo ? ' checked' : ''}> Pagar interés mensual sobre el ahorro</label>
        <label>Interés mensual (%)<input name="interesMensual" type="number" min="0" max="20" step="0.5" value="${esc(c.interesMensual)}"></label>
        <label>Cambiar tu PIN (déjalo vacío para no cambiarlo)
          <input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="4 a 6 números"></label>
        ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
        <button class="btn primario">Guardar</button>
      </form>
      <form data-form="nino" class="tarjeta formulario">
        <h2>Agregar niño</h2>
        <label>Nombre<input name="nombre" maxlength="40" required></label>
        <label>Sueldo<input name="sueldo" type="number" min="0" step="100" inputmode="numeric" required></label>
        <label>Se le paga
          <select name="frecuencia"><option value="semanal">Cada semana</option><option value="cuatrisemanal">Cada 4 semanas</option></select></label>
        <label>Ahorro sugerido por pago<input name="ahorroSugerido" type="number" min="0" step="100" inputmode="numeric" value="0" required></label>
        <label>Ahorro que ya tiene (opcional)<input name="ahorroInicial" type="number" min="0" step="100" inputmode="numeric"></label>
        <button class="btn">Agregar</button>
      </form>
      <section class="tarjeta">
        <h2>Respaldo</h2>
        <p class="suave">${S.enNube
          ? 'Los datos se guardan en la nube. Un respaldo de vez en cuando sirve como copia de seguridad.'
          : 'Los datos se guardan solo en este dispositivo y navegador. Descarga un respaldo de vez en cuando.'}</p>
        <div class="fila">
          <button class="btn" data-a="respaldo">Descargar respaldo</button>
          <label class="btn">Restaurar respaldo<input type="file" accept="application/json,.json" data-restaurar hidden></label>
        </div>
      </section>
    </main>`;
  }

  // ---------- Ventanas ----------
  function abrirModal(html) {
    $modal.innerHTML = `<div class="fondo" data-a="cerrar-fondo"><div class="ventana" role="dialog" aria-modal="true">${html}</div></div>`;
  }
  function cerrarModal() { $modal.innerHTML = ''; alConfirmar = null; }

  function confirmar(texto, boton, accion) {
    alConfirmar = accion;
    abrirModal(`
      <p>${esc(texto)}</p>
      <div class="fila fin"><button class="btn" data-a="cerrar">Cancelar</button>
        <button class="btn peligro" data-a="confirmar">${esc(boton)}</button></div>`);
  }

  function modalPagar(id) {
    const n = L.buscarNino(state, id);
    const c = L.calcularPago(n, L.hechasDe(n));
    abrirModal(`
      <h2>Pagar a ${esc(n.nombre)}</h2>
      <form data-form="pagar" data-id="${n.id}" class="formulario">
        <label>Fecha<input name="fecha" type="date" value="${L.hoy()}" required></label>
        ${n.tareas.length ? `
        <fieldset><legend>Tareas cumplidas</legend>
          <p class="suave">Vienen marcadas las que se marcaron durante la semana. Confirma o corrige.</p>
          ${n.tareas.map((t) => `<label class="casilla"><input type="checkbox" name="tarea" value="${t.id}"${t.hecha ? ' checked' : ''}> ${esc(t.nombre)}</label>`).join('')}
          <button type="button" class="enlace" data-a="marcar-todas">Marcar todas</button>
        </fieldset>` : ''}
        <label>¿Cuánto decide ahorrar? (${Number.isFinite(n.ahorroPropuesto) ? `${esc(n.nombre)} propuso ${$(n.ahorroPropuesto)}; ` : ''}sugerido ${$(n.ahorroSugerido)})
          <input name="ahorro" type="number" min="0" step="100" inputmode="numeric" value="${c.ahorro}" required></label>
        <div class="calculo" id="calculo"></div>
        <label>Nota (opcional)<input name="nota" maxlength="120"></label>
        <div class="fila fin"><button type="button" class="btn" data-a="cerrar">Cancelar</button>
          <button class="btn primario">Registrar pago</button></div>
      </form>`);
    recalcular();
  }

  function leerPago(form) {
    const n = L.buscarNino(state, form.dataset.id);
    const cumplidasIds = [...form.querySelectorAll('input[name=tarea]:checked')].map((i) => i.value);
    const valor = form.elements.ahorro.value;
    const ahorro = valor === '' ? 0 : Number(valor);
    return { n, cumplidasIds, ahorro, c: L.calcularPago(n, cumplidasIds, ahorro) };
  }

  function recalcular() {
    const form = $modal.querySelector('form[data-form=pagar]');
    if (!form) return;
    const { c, ahorro } = leerPago(form);
    const tope = ahorro > c.maxAhorro;
    document.getElementById('calculo').innerHTML = `
      <div><span>Ganado${c.tareasTotal ? ` (${c.tareasCumplidas} de ${c.tareasTotal} tareas)` : ''}</span><b>${$(c.ganado)}</b></div>
      <div><span>Diezmo (10%)</span><b>− ${$(c.diezmo)}</b></div>
      <div><span>Ahorro</span><b>− ${$(c.ahorro)}</b></div>
      <div class="final"><span>Le entregas en mano</span><b>${$(c.libre)}</b></div>
      ${tope ? `<p class="error">Lo máximo que puede ahorrar en este pago es ${$(c.maxAhorro)}.</p>` : ''}`;
  }

  function modalMonto(tipo, id) {
    const n = L.buscarNino(state, id);
    const saldo = L.resumen(state, id).ahorrado;
    const retiro = tipo === 'retiro';
    abrirModal(`
      <h2>${retiro ? 'Retiro del ahorro de' : 'Abono extra al ahorro de'} ${esc(n.nombre)}</h2>
      <p class="suave">${retiro ? `Tiene ${$(saldo)} ahorrados.` : 'Para dinero que quiere guardar aparte del sueldo (un regalo, por ejemplo).'}</p>
      <form data-form="${tipo}" data-id="${n.id}" class="formulario">
        <label>Fecha<input name="fecha" type="date" value="${L.hoy()}" required></label>
        <label>Monto<input name="monto" type="number" min="100" step="100" inputmode="numeric" ${retiro ? `max="${saldo}"` : ''} required></label>
        <label>${retiro ? '¿Para qué lo retira?' : 'Nota'} (opcional)<input name="nota" maxlength="120"></label>
        <p class="error" id="error-monto"></p>
        <div class="fila fin"><button type="button" class="btn" data-a="cerrar">Cancelar</button>
          <button class="btn primario">${retiro ? 'Registrar retiro' : 'Registrar abono'}</button></div>
      </form>`);
  }

  function modalPin(id) {
    const n = L.buscarNino(state, id);
    abrirModal(`
      <h2>PIN de ${esc(n.nombre)}</h2>
      <p class="suave">Con este PIN ${esc(n.nombre)} entra a ver su cuenta. Elígelo con ${esc(n.nombre)} y que no lo comparta.</p>
      <form data-form="pin" data-id="${n.id}" class="formulario">
        <label>PIN nuevo (4 a 6 números)
          <input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" required></label>
        <label>Repite el PIN
          <input name="pin2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" required></label>
        <p class="error" id="error-pin"></p>
        <div class="fila fin"><button type="button" class="btn" data-a="cerrar">Cancelar</button>
          <button class="btn primario">Guardar PIN</button></div>
      </form>`);
  }

  function modalComprobante(movId) {
    const m = state.movimientos.find((x) => x.id === movId);
    if (!m) return;
    const n = L.buscarNino(state, m.ninoId);
    const texto = L.textoComprobante(state, m);
    abrirModal(`
      <div class="comprobante" style="--color:${esc(n.color)}">
        <p class="suave">Comprobante de pago</p>
        <h2>${esc(n.nombre)}</h2>
        <p class="suave">${esc(L.fechaLarga(m.fecha))}</p>
        ${m.tareas && m.tareas.length ? `<ul class="lista chica">${m.tareas.map((t) => `<li>${t.cumplida ? '✅' : '❌'} ${esc(t.nombre)}</li>`).join('')}</ul>` : ''}
        <div class="calculo">
          <div><span>Ganado</span><b>${$(m.ganado)}</b></div>
          <div><span>Diezmo (10%)</span><b>− ${$(m.diezmo)}</b></div>
          <div><span>Ahorro</span><b>− ${$(m.ahorro)}</b></div>
          <div class="final"><span>En mano</span><b>${$(m.libre)}</b></div>
        </div>
        <p class="suave">Total ahorrado hoy: <strong>${$(L.resumen(state, n.id).ahorrado)}</strong></p>
        ${m.nota ? `<p class="detalle">${esc(m.nota)}</p>` : ''}
      </div>
      <div class="fila fin">
        <button class="btn" data-a="cerrar">Cerrar</button>
        <button class="btn" data-a="copiar" data-id="${m.id}">Copiar</button>
        <a class="btn primario" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(texto)}">Enviar por WhatsApp</a>
      </div>`);
  }

  // ---------- Dibujar ----------
  function render() {
    let html;
    if (ui.cargando) html = '<main class="centro"><h1 class="marca">Mi Sueldo</h1><p class="suave">Cargando…</p></main>';
    else if (ui.fallo) {
      html = `<main class="centro"><h1 class="marca">Mi Sueldo</h1>
        <p class="suave">No se pudo conectar. Revisa tu conexión a internet.</p>
        <button class="btn primario" data-a="reintentar">Reintentar</button></main>`;
    } else if (!ui.portada.configurada) html = vistaCrearPin();
    else if (!ui.sesion) html = ui.perfil ? vistaPin() : vistaPerfiles();
    else if (ui.sesion.rol === 'nino') html = vistaNino(ui.sesion.id, false);
    else if (ui.pantalla === 'nino') html = vistaNino(ui.ninoId, true);
    else if (ui.pantalla === 'ajustes') html = vistaAjustes();
    else html = vistaInicio();
    $app.innerHTML = html;
    ui.error = '';
    const foco = $app.querySelector('[autofocus]');
    if (foco) foco.focus();
  }
  const ninoActual = () => L.buscarNino(state, ui.ninoId);

  // ---------- Clics ----------
  const acciones = {
    perfil: (id) => { ui.perfil = id; },
    'volver-perfiles': () => { ui.perfil = null; },
    salir: () => {
      S.salir(); ui.sesion = null; state = null; ui.perfil = null; ui.pantalla = 'inicio';
      cerrarModal(); arrancar();
      return false;
    },
    reintentar: () => { arrancar(); return false; },
    inicio: () => { ui.pantalla = 'inicio'; },
    ajustes: () => { ui.pantalla = 'ajustes'; },
    'ver-nino': (id) => { ui.pantalla = 'nino'; ui.ninoId = id; ui.tab = 'movimientos'; },
    tab: (id) => { ui.tab = id; },
    pagar: (id) => { modalPagar(id); return false; },
    retiro: (id) => { modalMonto('retiro', id); return false; },
    abono: (id) => { modalMonto('abono', id); return false; },
    pin: (id) => { modalPin(id); return false; },
    'marcar-tarea': (id) => {
      const n = esAdmin() ? ninoActual() : state.ninos[0];
      const t = n && n.tareas.find((x) => x.id === id);
      if (!t) return false;
      t.hecha = !t.hecha;
      if (esAdmin()) guardar(); else enviarAccionNino({ tipo: 'tarea', tareaId: id, hecha: t.hecha });
    },
    'marcar-todas': () => {
      $modal.querySelectorAll('input[name=tarea]').forEach((i) => { i.checked = true; });
      recalcular();
      return false;
    },
    instalar: () => { if (instalar) instalar.prompt(); instalar = null; },
    comprobante: (id) => { modalComprobante(id); return false; },
    cerrar: () => { cerrarModal(); return false; },
    confirmar: () => { const f = alConfirmar; cerrarModal(); if (f) f(); },
    copiar: (id) => {
      const m = state.movimientos.find((x) => x.id === id);
      navigator.clipboard.writeText(L.textoComprobante(state, m)).then(
        () => aviso('Comprobante copiado'), () => aviso('No se pudo copiar'));
      return false;
    },
    interes: () => {
      const hechos = L.aplicarInteres(state);
      guardar();
      aviso(hechos.length ? `Interés pagado a ${hechos.length} ${hechos.length === 1 ? 'cuenta' : 'cuentas'}` : 'No había interés por pagar');
    },
    'borrar-mov': (id) => {
      confirmar('¿Eliminar este movimiento? Los totales se recalculan.', 'Eliminar', () => {
        L.eliminarMovimiento(state, id); guardar(); render();
      });
      return false;
    },
    'borrar-tarea': (id) => { const n = ninoActual(); n.tareas = n.tareas.filter((t) => t.id !== id); guardar(); },
    'borrar-meta': (id) => { const n = ninoActual(); n.metas = n.metas.filter((m) => m.id !== id); guardar(); },
    respaldo: () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
      a.download = `mi-sueldo-respaldo-${L.hoy()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      return false;
    },
  };
  // Lo que un niño puede tocar en su sesión; el resto es solo del administrador.
  const PERMITIDO_NINO = ['salir', 'comprobante', 'cerrar', 'copiar', 'marcar-tarea'];
  const SIN_SESION = ['perfil', 'volver-perfiles', 'reintentar', 'instalar'];

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-a]');
    if (!el) return;
    const a = el.dataset.a;
    if (a === 'cerrar-fondo') { if (ev.target === el) cerrarModal(); return; }
    if (!acciones[a]) return;
    if (!ui.sesion && !SIN_SESION.includes(a)) return;
    if (ui.sesion && !esAdmin() && !PERMITIDO_NINO.includes(a)) return;
    if (acciones[a](el.dataset.id) !== false) render();
  });

  $modal.addEventListener('input', recalcular);

  // ---------- Formularios ----------
  const formularios = {
    'crear-pin': (d) => {
      if (!pinValido(d.pin)) return 'El PIN debe tener de 4 a 6 números.';
      if (d.pin !== d.pin2) return 'Los dos PIN no coinciden.';
      return S.crear(d.pin).then((r) => {
        if (!r.ok) return r.error === 'existe' ? 'Esta app ya tiene administrador. Recarga la página.' : 'No se pudo crear el PIN.';
        aplicarEntrada(r);
        return S.perfiles().then((p) => { ui.portada = p; });
      });
    },
    entrar: (d) => S.entrar(ui.perfil, d.pin).then((r) => {
      if (!r.ok) return r.error === 'bloqueado' ? 'Demasiados intentos. Espera 15 minutos.' : 'PIN incorrecto.';
      aplicarEntrada(r);
      ui.perfil = null;
    }),
    pagar: (d, form) => {
      const { n, cumplidasIds, ahorro, c } = leerPago(form);
      if (ahorro > c.maxAhorro) return false; // el aviso ya está en pantalla
      const mov = L.registrarPago(state, n.id, { fecha: d.fecha, cumplidasIds, ahorro, nota: d.nota.trim() });
      guardar(); render(); modalComprobante(mov.id);
      return false;
    },
    ahorro: (d) => {
      const n = state.ninos[0];
      const monto = Number(d.monto);
      if (!Number.isInteger(monto) || monto < 0 || monto > n.sueldo) return 'Escribe un monto entre 0 y tu sueldo.';
      n.ahorroPropuesto = monto;
      enviarAccionNino({ tipo: 'ahorro', monto });
      aviso('Ahorro guardado');
    },
    pin: (d, form) => {
      const error = (texto) => { document.getElementById('error-pin').textContent = texto; return false; };
      if (!pinValido(d.pin)) return error('El PIN debe tener de 4 a 6 números.');
      if (d.pin !== d.pin2) return error('Los dos PIN no coinciden.');
      const id = form.dataset.id;
      return S.ponerPin(id, d.pin).then((r) => {
        if (!r.ok) return error('No se pudo guardar el PIN. Intenta de nuevo.');
        if (!conPin.includes(id)) conPin.push(id);
        cerrarModal(); aviso('PIN guardado');
      }, () => error('No hay conexión. Intenta de nuevo.'));
    },
    retiro: (d, form) => movimientoMonto(L.registrarRetiro, d, form, 'Retiro registrado'),
    abono: (d, form) => movimientoMonto(L.registrarAbono, d, form, 'Abono registrado'),
    nino: (d) => {
      L.agregarNino(state, Object.assign({}, d, { nombre: d.nombre.trim() }));
      guardar(); ui.pantalla = 'inicio'; aviso('Niño agregado. Créale su PIN en Ver cuenta → Datos.');
    },
    tarea: (d) => { ninoActual().tareas.push({ id: L.uid(), nombre: d.nombre.trim() }); guardar(); },
    meta: (d) => {
      ninoActual().metas.push({ id: L.uid(), nombre: d.nombre.trim(), precio: Number(d.precio) }); guardar();
    },
    datos: (d) => {
      if (d.pin && !pinValido(d.pin)) return 'El PIN debe tener de 4 a 6 números.';
      const n = ninoActual();
      Object.assign(n, {
        nombre: d.nombre.trim(), sueldo: Number(d.sueldo), frecuencia: d.frecuencia,
        ahorroSugerido: Number(d.ahorroSugerido), proximoPago: d.proximoPago,
      });
      guardar();
      if (!d.pin) { aviso('Datos guardados'); return; }
      return S.ponerPin(n.id, d.pin).then((r) => {
        if (!r.ok) return 'Los datos se guardaron, pero no se pudo guardar el PIN.';
        if (!conPin.includes(n.id)) conPin.push(n.id);
        aviso('Datos y PIN guardados');
      });
    },
    ajustes: (d) => {
      if (d.pin && !pinValido(d.pin)) return 'El PIN debe tener de 4 a 6 números.';
      const c = state.config;
      c.adminNombre = d.adminNombre.trim() || c.adminNombre;
      c.interesActivo = d.interesActivo === 'on';
      c.interesMensual = Number(d.interesMensual) || 0;
      guardar();
      if (!d.pin) { aviso('Ajustes guardados'); return; }
      return S.ponerPin('admin', d.pin).then((r) => {
        if (!r.ok) return 'Los ajustes se guardaron, pero no se pudo cambiar el PIN.';
        aviso('Ajustes y PIN guardados');
      });
    },
  };
  const FORMULARIOS_LIBRES = ['crear-pin', 'entrar'];
  const FORMULARIOS_NINO = ['ahorro'];

  function movimientoMonto(operacion, d, form, mensaje) {
    try {
      operacion(state, form.dataset.id, { fecha: d.fecha, monto: Number(d.monto), nota: d.nota.trim() });
    } catch (e) {
      document.getElementById('error-monto').textContent = e.message;
      return false;
    }
    guardar(); cerrarModal(); aviso(mensaje);
  }

  document.addEventListener('submit', (ev) => {
    const form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    const nombre = form.dataset.form;
    const deNino = Boolean(ui.sesion) && !esAdmin() && FORMULARIOS_NINO.includes(nombre);
    if (!FORMULARIOS_LIBRES.includes(nombre) && !esAdmin() && !deNino) return;
    if (esAdmin() && FORMULARIOS_NINO.includes(nombre)) return;
    const datos = Object.fromEntries(new FormData(form));
    const boton = form.querySelector('button:not([type=button])');
    if (boton) boton.disabled = true;
    Promise.resolve()
      .then(() => formularios[nombre](datos, form))
      .catch(() => 'No hay conexión. Intenta de nuevo.')
      .then((resultado) => {
        if (boton) boton.disabled = false;
        if (resultado === false) return;
        if (typeof resultado === 'string') ui.error = resultado;
        render();
      });
  });

  // Restaurar un respaldo (solo el administrador ve este control).
  document.addEventListener('change', (ev) => {
    if (!ev.target.matches('[data-restaurar]') || !esAdmin()) return;
    const archivo = ev.target.files[0];
    if (!archivo) return;
    archivo.text().then((texto) => {
      let datos;
      try { datos = JSON.parse(texto); } catch (e) { datos = null; }
      if (!datos || !Array.isArray(datos.ninos) || !Array.isArray(datos.movimientos) || !datos.config) {
        aviso('Ese archivo no es un respaldo válido'); return;
      }
      confirmar('¿Reemplazar todos los datos actuales por los del respaldo?', 'Reemplazar', () => {
        state = datos; guardar(); render(); aviso('Respaldo restaurado (los PIN no cambian)');
      });
    });
  });

  // Al volver a la app, un niño ve su cuenta al día.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !ui.sesion || esAdmin() || $modal.innerHTML) return;
    S.reanudar().then((r) => { if (r && r.ok) { aplicarEntrada(r); render(); } }).catch(() => {});
  });

  arrancar();
})();
