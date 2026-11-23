// Reglas y cálculos de "Mi Sueldo". Sin DOM: se puede probar con Node.
(function (root) {
  'use strict';

  const DIEZMO = 0.10;

  // ---------- Fechas (siempre hora local, formato AAAA-MM-DD) ----------
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseFecha = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const hoy = () => iso(new Date());
  const sumarDias = (s, n) => {
    const d = parseFecha(s);
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  // El sábado de esa semana (el mismo día si ya es sábado).
  const proximoSabado = (s) => sumarDias(s, (6 - parseFecha(s).getDay() + 7) % 7);

  const redondear = (n, paso) => Math.round(n / paso) * paso;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const diasFrecuencia = (nino) => (nino.frecuencia === 'cuatrisemanal' ? 28 : 7);

  // ---------- Estado inicial ----------
  const COLORES = ['#e0559a', '#8b5cf6', '#0ea5a4', '#f59e0b', '#3b82f6', '#ef4444'];

  // Agrega un niño. Si trae ahorroInicial, queda como su primer movimiento.
  function agregarNino(state, datos, fecha) {
    const f = fecha || hoy();
    const nino = {
      id: uid(), nombre: datos.nombre, color: COLORES[state.ninos.length % COLORES.length],
      sueldo: Number(datos.sueldo) || 0,
      frecuencia: datos.frecuencia === 'cuatrisemanal' ? 'cuatrisemanal' : 'semanal',
      ahorroSugerido: Number(datos.ahorroSugerido) || 0,
      proximoPago: proximoSabado(f), tareas: [], metas: [],
    };
    state.ninos.push(nino);
    if (Number(datos.ahorroInicial) > 0) {
      state.movimientos.push({
        id: uid(), ninoId: nino.id, fecha: f, tipo: 'saldo_inicial', monto: Number(datos.ahorroInicial),
        nota: 'Ahorro que ya tenía antes de usar la app',
      });
    }
    return nino;
  }

  // semilla (opcional): { adminNombre, ninos: [{ nombre, sueldo, frecuencia, ahorroSugerido, ahorroInicial }] }
  function estadoInicial(fecha, semilla) {
    const state = {
      version: 1,
      config: { adminNombre: (semilla && semilla.adminNombre) || 'Administrador', interesActivo: true, interesMensual: 2 },
      ninos: [], movimientos: [],
    };
    for (const d of (semilla && semilla.ninos) || []) agregarNino(state, d, fecha);
    return state;
  }

  const buscarNino = (state, id) => state.ninos.find((n) => n.id === id);
  // Del más reciente al más antiguo; en un mismo día, primero el último que se registró.
  const movimientosDe = (state, ninoId) =>
    state.movimientos
      .filter((m) => m.ninoId === ninoId)
      .reverse()
      .sort((a, b) => (a.fecha === b.fecha ? 0 : a.fecha < b.fecha ? 1 : -1));

  // ---------- Cálculo de un pago ----------
  // cumplidasIds: ids de las tareas activas que sí cumplió. ahorroDeseado: lo que decide ahorrar.
  function calcularPago(nino, cumplidasIds, ahorroDeseado) {
    const tareas = nino.tareas;
    const total = tareas.length;
    const cumplidas = tareas.filter((t) => cumplidasIds.includes(t.id)).length;
    const ganado = total === 0 ? nino.sueldo : redondear((nino.sueldo * cumplidas) / total, 100);
    const diezmo = redondear(ganado * DIEZMO, 100);
    const maxAhorro = ganado - diezmo;
    // Sin monto explícito vale lo que el niño propuso y, si no propuso nada, lo sugerido.
    let ahorro = Number.isFinite(ahorroDeseado) ? ahorroDeseado
      : Number.isFinite(nino.ahorroPropuesto) ? nino.ahorroPropuesto : nino.ahorroSugerido;
    ahorro = Math.max(0, Math.min(Math.round(ahorro), maxAhorro));
    return {
      sueldoBase: nino.sueldo, tareasTotal: total, tareasCumplidas: cumplidas,
      ganado, diezmo, ahorro, maxAhorro, libre: ganado - diezmo - ahorro,
    };
  }

  // ---------- Lo que un niño puede cambiar de su propia cuenta ----------
  const hechasDe = (nino) => nino.tareas.filter((t) => t.hecha).map((t) => t.id);

  // accion: { tipo: 'tarea', tareaId, hecha } o { tipo: 'ahorro', monto } (monto null = quitar la propuesta).
  // Devuelve false si la acción no es válida. La misma regla está en supabase/instalar.sql (ms_nino_accion).
  function accionNino(estado, ninoId, accion) {
    const nino = buscarNino(estado, ninoId);
    if (!nino || !accion) return false;
    if (accion.tipo === 'tarea') {
      const t = nino.tareas.find((x) => x.id === accion.tareaId);
      if (!t || typeof accion.hecha !== 'boolean') return false;
      t.hecha = accion.hecha;
      return true;
    }
    if (accion.tipo === 'ahorro') {
      if (accion.monto === null) { nino.ahorroPropuesto = null; return true; }
      if (!Number.isInteger(accion.monto) || accion.monto < 0 || accion.monto > nino.sueldo) return false;
      nino.ahorroPropuesto = accion.monto;
      return true;
    }
    return false;
  }

  // ---------- Totales por niño ----------
  function resumen(state, ninoId) {
    const r = { ahorrado: 0, ganado: 0, diezmado: 0, enMano: 0, intereses: 0, retirado: 0, pagos: 0 };
    for (const m of state.movimientos) {
      if (m.ninoId !== ninoId) continue;
      if (m.tipo === 'pago') {
        r.ganado += m.ganado; r.diezmado += m.diezmo; r.enMano += m.libre;
        r.ahorrado += m.ahorro; r.pagos += 1;
      } else if (m.tipo === 'saldo_inicial' || m.tipo === 'abono') {
        r.ahorrado += m.monto;
      } else if (m.tipo === 'interes') {
        r.ahorrado += m.monto; r.intereses += m.monto;
      } else if (m.tipo === 'retiro') {
        r.ahorrado -= m.monto; r.retirado += m.monto;
      }
    }
    return r;
  }

  // ---------- Operaciones (modifican el estado y devuelven el movimiento) ----------
  function registrarPago(state, ninoId, { fecha, cumplidasIds, ahorro, nota }) {
    const nino = buscarNino(state, ninoId);
    const c = calcularPago(nino, cumplidasIds || [], ahorro);
    const mov = {
      id: uid(), ninoId, fecha: fecha || hoy(), tipo: 'pago', nota: nota || '',
      sueldoBase: c.sueldoBase, ganado: c.ganado, diezmo: c.diezmo, ahorro: c.ahorro, libre: c.libre,
      tareas: nino.tareas.map((t) => ({ nombre: t.nombre, cumplida: (cumplidasIds || []).includes(t.id) })),
    };
    state.movimientos.push(mov);
    // Empieza un periodo nuevo: tareas sin marcar y sin ahorro propuesto.
    for (const t of nino.tareas) t.hecha = false;
    nino.ahorroPropuesto = null;
    // El siguiente pago queda para la próxima fecha que todavía no ha pasado.
    let prox = nino.proximoPago || mov.fecha;
    while (prox <= mov.fecha) prox = sumarDias(prox, diasFrecuencia(nino));
    nino.proximoPago = prox;
    return mov;
  }

  function registrarRetiro(state, ninoId, { fecha, monto, nota }) {
    const saldo = resumen(state, ninoId).ahorrado;
    if (!(monto > 0)) throw new Error('Escribe un monto mayor que cero.');
    if (monto > saldo) throw new Error('No puede retirar más de lo que tiene ahorrado.');
    const mov = { id: uid(), ninoId, fecha: fecha || hoy(), tipo: 'retiro', monto, nota: nota || '' };
    state.movimientos.push(mov);
    return mov;
  }

  function registrarAbono(state, ninoId, { fecha, monto, nota }) {
    if (!(monto > 0)) throw new Error('Escribe un monto mayor que cero.');
    const mov = { id: uid(), ninoId, fecha: fecha || hoy(), tipo: 'abono', monto, nota: nota || '' };
    state.movimientos.push(mov);
    return mov;
  }

  const mesDe = (fecha) => fecha.slice(0, 7);
  const interesYaAplicado = (state, ninoId, fecha) =>
    state.movimientos.some((m) => m.ninoId === ninoId && m.tipo === 'interes' && mesDe(m.fecha) === mesDe(fecha));

  // Paga el interés del mes sobre lo ahorrado. Una sola vez por niño y por mes.
  function aplicarInteres(state, fecha) {
    const f = fecha || hoy();
    const tasa = Number(state.config.interesMensual) || 0;
    const aplicados = [];
    if (!state.config.interesActivo || tasa <= 0) return aplicados;
    for (const n of state.ninos) {
      if (interesYaAplicado(state, n.id, f)) continue;
      const saldo = resumen(state, n.id).ahorrado;
      const monto = redondear((saldo * tasa) / 100, 50);
      if (monto <= 0) continue;
      const mov = {
        id: uid(), ninoId: n.id, fecha: f, tipo: 'interes', monto, tasa, base: saldo,
        nota: `Interés del ${tasa}% sobre ${dinero(saldo)}`,
      };
      state.movimientos.push(mov);
      aplicados.push(mov);
    }
    return aplicados;
  }

  function eliminarMovimiento(state, id) {
    state.movimientos = state.movimientos.filter((m) => m.id !== id);
  }

  // ---------- Textos ----------
  const dinero = (n) => '$' + Math.round(n || 0).toLocaleString('es-CO');
  const fechaLarga = (s) =>
    parseFecha(s).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fechaCorta = (s) =>
    parseFecha(s).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });

  const NOMBRES_TIPO = {
    pago: 'Pago de sueldo', retiro: 'Retiro de ahorro', abono: 'Abono extra al ahorro',
    interes: 'Interés ganado', saldo_inicial: 'Ahorro inicial',
  };
  const nombreTipo = (m) => NOMBRES_TIPO[m.tipo] || m.tipo;
  // Cuánto cambia el ahorro con este movimiento.
  const efectoAhorro = (m) => (m.tipo === 'pago' ? m.ahorro : m.tipo === 'retiro' ? -m.monto : m.monto);

  function textoComprobante(state, mov) {
    const nino = buscarNino(state, mov.ninoId);
    const saldo = resumen(state, mov.ninoId).ahorrado;
    const l = [`*Comprobante de pago · ${nino ? nino.nombre : ''}*`, fechaLarga(mov.fecha), ''];
    if (mov.tareas && mov.tareas.length) {
      l.push('Tareas:');
      for (const t of mov.tareas) l.push(`${t.cumplida ? '✅' : '❌'} ${t.nombre}`);
      l.push('');
    }
    l.push(`Ganado: ${dinero(mov.ganado)}`);
    if (mov.ganado !== mov.sueldoBase) l.push(`(sueldo completo: ${dinero(mov.sueldoBase)})`);
    l.push(`Diezmo (10%): ${dinero(mov.diezmo)}`);
    l.push(`Ahorro: ${dinero(mov.ahorro)}`);
    l.push(`Recibes en mano: ${dinero(mov.libre)}`);
    l.push('', `Total ahorrado hoy: ${dinero(saldo)}`);
    if (mov.nota) l.push('', mov.nota);
    return l.join('\n');
  }

  root.Logic = {
    DIEZMO, hoy, sumarDias, proximoSabado, uid, diasFrecuencia, estadoInicial, agregarNino, buscarNino,
    movimientosDe, calcularPago, hechasDe, accionNino, resumen, registrarPago, registrarRetiro, registrarAbono,
    aplicarInteres, interesYaAplicado, eliminarMovimiento, dinero, fechaLarga, fechaCorta,
    nombreTipo, efectoAhorro, textoComprobante,
  };
})(typeof window !== 'undefined' ? window : globalThis);
