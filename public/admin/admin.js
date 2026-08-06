const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginMessage = document.getElementById('login-message');
const adminPanel = document.getElementById('admin-panel');
const btnLogout = document.getElementById('btn-logout');

const navTabs = document.querySelectorAll('.nav-tab');
const tabPanels = {
  dashboard: document.getElementById('tab-dashboard'),
  usuarios: document.getElementById('tab-usuarios'),
  checkins: document.getElementById('tab-checkins'),
};

let distritosCache = [];

// ---------------------------------------------------------------------------
// Modal (reemplaza confirm()/alert() nativos)
// ---------------------------------------------------------------------------

const modalOverlay = document.getElementById('modal-overlay');
const modalBox = modalOverlay.querySelector('.modal-box');
const modalMessage = document.getElementById('modal-message');
const modalBtnConfirm = document.getElementById('modal-btn-confirm');
const modalBtnCancel = document.getElementById('modal-btn-cancel');

let modalResolve = null;

function cerrarModal(resultado) {
  modalOverlay.classList.add('hidden');
  if (modalResolve) {
    modalResolve(resultado);
    modalResolve = null;
  }
}

modalBtnConfirm.addEventListener('click', () => cerrarModal(true));
modalBtnCancel.addEventListener('click', () => cerrarModal(false));
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) cerrarModal(false);
});

// mostrarConfirm: reemplazo de confirm(mensaje) -> Promise<boolean>
function mostrarConfirm(mensaje) {
  modalBox.classList.remove('modal-alert');
  modalMessage.textContent = mensaje;
  modalOverlay.classList.remove('hidden');
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

// mostrarAlert: reemplazo de alert(mensaje) -> Promise<void>
function mostrarAlert(mensaje) {
  modalBox.classList.add('modal-alert');
  modalMessage.textContent = mensaje;
  modalOverlay.classList.remove('hidden');
  return new Promise((resolve) => {
    modalResolve = () => resolve();
  });
}

function fmtFecha(iso) {
  if (!iso) return '';
  return String(iso).slice(0, 10);
}

function fmtFechaHora(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-PE');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function checkSession() {
  const res = await fetch('/api/admin/session');
  const data = await res.json();
  if (data.authenticated) {
    mostrarPanel();
  } else {
    mostrarLogin();
  }
}

function mostrarLogin() {
  loginScreen.classList.remove('hidden');
  adminPanel.classList.add('hidden');
}

function mostrarPanel() {
  loginScreen.classList.add('hidden');
  adminPanel.classList.remove('hidden');
  initPanel();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginMessage.textContent = '';
  loginMessage.className = 'message';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: loginPassword.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al ingresar');
    loginPassword.value = '';
    mostrarPanel();
  } catch (err) {
    loginMessage.textContent = err.message;
    loginMessage.className = 'message error';
  }
});

btnLogout.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  mostrarLogin();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let panelInitialized = false;

navTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    navTabs.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.values(tabPanels).forEach((p) => p.classList.add('hidden'));
    tabPanels[btn.dataset.tab].classList.remove('hidden');
  });
});

async function initPanel() {
  if (panelInitialized) return;
  panelInitialized = true;

  const [distritos, hoyData] = await Promise.all([
    fetch('/api/distritos').then((r) => r.json()),
    fetch('/api/admin/hoy').then((r) => r.json()),
  ]);
  distritosCache = distritos;

  llenarSelect(document.getElementById('usuarios-distrito'), distritosCache);
  llenarSelect(document.getElementById('checkins-distrito'), distritosCache);

  // Por defecto, Asistencias solo muestra las del día de hoy (en Perú).
  document.getElementById('checkins-desde').value = hoyData.fecha;
  document.getElementById('checkins-hasta').value = hoyData.fecha;

  configurarDashboard();
  configurarTabla(usuariosConfig);
  configurarTabla(checkinsConfig);
}

function llenarSelect(select, valores) {
  valores.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const dashboardPreset = document.getElementById('dashboard-preset');
const dashboardDesde = document.getElementById('dashboard-desde');
const dashboardHasta = document.getElementById('dashboard-hasta');
const dashboardDesdeWrap = document.getElementById('dashboard-desde-wrap');
const dashboardHastaWrap = document.getElementById('dashboard-hasta-wrap');

function configurarDashboard() {
  dashboardPreset.addEventListener('change', () => {
    const esRango = dashboardPreset.value === 'rango';
    dashboardDesdeWrap.classList.toggle('hidden', !esRango);
    dashboardHastaWrap.classList.toggle('hidden', !esRango);
    if (!esRango || (dashboardDesde.value && dashboardHasta.value)) cargarDashboard();
  });
  dashboardDesde.addEventListener('change', cargarDashboard);
  dashboardHasta.addEventListener('change', cargarDashboard);

  cargarDashboard();
}

async function cargarDashboard() {
  const params = new URLSearchParams({ preset: dashboardPreset.value });
  if (dashboardPreset.value === 'rango') {
    if (!dashboardDesde.value || !dashboardHasta.value) return;
    params.set('desde', dashboardDesde.value);
    params.set('hasta', dashboardHasta.value);
  }

  const res = await fetch(`/api/admin/dashboard?${params.toString()}`);
  const data = await res.json();

  document.getElementById('stat-total-clientes').textContent = data.totalClientes;
  document.getElementById('stat-clientes-unicos').textContent = data.clientesUnicos;
  document.getElementById('stat-asistencias').textContent = data.asistencias;
  document.getElementById('stat-servicios').textContent = data.serviciosRealizados;
  document.getElementById('stat-pilates').textContent = data.pilates;
  document.getElementById('stat-estetica').textContent = data.estetica;

  const body = document.getElementById('ultimos-clientes-body');
  body.innerHTML = '';
  data.ultimosClientes.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.documento}</td>
      <td>${c.paciente || ''}</td>
      <td>${c.apodo || ''}</td>
      <td>${c.distrito || ''}</td>
      <td>${fmtFechaHora(c.fecha_creacion)}</td>
    `;
    body.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Infinite-scroll filtered tables (reused for Usuarios and Check-ins)
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function configurarTabla(config) {
  let offset = 0;
  let hasMore = true;
  let loading = false;

  function filtros() {
    return {
      q: config.qInput.value.trim(),
      distrito: config.distritoInput.value,
      area: config.areaInput.value,
      servicio: config.servicioInput.value.trim(),
      desde: config.desdeInput.value,
      hasta: config.hastaInput.value,
    };
  }

  async function cargarPagina({ reset }) {
    if (loading) return;
    if (reset) {
      offset = 0;
      hasMore = true;
      config.body.innerHTML = '';
      if (config.onFiltrosCambian) config.onFiltrosCambian(filtros());
    }
    if (!hasMore) return;

    loading = true;
    config.statusEl.textContent = 'Cargando...';

    const params = new URLSearchParams({ ...filtros(), offset: String(offset) });
    Object.keys(filtros()).forEach((k) => {
      if (!params.get(k)) params.delete(k);
    });

    try {
      const res = await fetch(`${config.endpoint}?${params.toString()}`);
      const data = await res.json();
      data.rows.forEach((row) => config.body.appendChild(config.renderRow(row)));
      hasMore = data.hasMore;
      offset += data.rows.length;
      config.statusEl.textContent = hasMore ? '' : 'No hay más resultados.';
      if (offset === 0 && data.rows.length === 0) {
        config.statusEl.textContent = 'Sin resultados.';
      }
    } catch (err) {
      config.statusEl.textContent = 'Error al cargar.';
    } finally {
      loading = false;
    }
  }

  const recargar = debounce(() => cargarPagina({ reset: true }), 400);

  [config.qInput, config.distritoInput, config.areaInput, config.servicioInput, config.desdeInput, config.hastaInput].forEach((el) => {
    el.addEventListener('input', recargar);
    el.addEventListener('change', recargar);
  });

  config.scrollContainer.addEventListener('scroll', () => {
    const el = config.scrollContainer;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      cargarPagina({ reset: false });
    }
  });

  cargarPagina({ reset: true });
}

// ---------------------------------------------------------------------------
// Usuarios tab
// ---------------------------------------------------------------------------

const usuariosConfig = {
  endpoint: '/api/admin/clientes',
  qInput: document.getElementById('usuarios-q'),
  distritoInput: document.getElementById('usuarios-distrito'),
  areaInput: document.getElementById('usuarios-area'),
  servicioInput: document.getElementById('usuarios-servicio'),
  desdeInput: document.getElementById('usuarios-desde'),
  hastaInput: document.getElementById('usuarios-hasta'),
  scrollContainer: document.getElementById('usuarios-scroll'),
  body: document.getElementById('usuarios-body'),
  statusEl: document.getElementById('usuarios-status'),
  renderRow(c) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.documento}</td>
      <td>${c.tipo_doc || ''}</td>
      <td>${c.paciente || ''}</td>
      <td>${c.apodo || ''}</td>
      <td>${c.celular || ''}</td>
      <td>${c.distrito || ''}</td>
      <td>${fmtFecha(c.f_nacimiento)}</td>
      <td>${c.edad ?? ''}</td>
      <td>${c.sexo || ''}</td>
      <td>${c.correo || ''}</td>
      <td>${c.direccion || ''}</td>
      <td>${fmtFechaHora(c.fecha_creacion)}</td>
      <td><button type="button" class="btn-delete-row" data-delete-cliente="${c.documento}" title="Eliminar usuario">✕</button></td>
    `;
    return tr;
  },
};

document.getElementById('usuarios-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-cliente]');
  if (!btn) return;
  const documento = btn.dataset.deleteCliente;
  const confirmado = await mostrarConfirm(`¿Eliminar al usuario con documento ${documento}? Esta acción también eliminará sus asistencias.`);
  if (!confirmado) return;

  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/clientes/${encodeURIComponent(documento)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al eliminar');
    btn.closest('tr').remove();
  } catch (err) {
    await mostrarAlert(err.message);
    btn.disabled = false;
  }
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
  const params = new URLSearchParams({
    q: usuariosConfig.qInput.value.trim(),
    distrito: usuariosConfig.distritoInput.value,
    area: usuariosConfig.areaInput.value,
    servicio: usuariosConfig.servicioInput.value.trim(),
    desde: usuariosConfig.desdeInput.value,
    hasta: usuariosConfig.hastaInput.value,
  });
  [...params.keys()].forEach((k) => {
    if (!params.get(k)) params.delete(k);
  });
  window.location.href = `/api/admin/clientes/export?${params.toString()}`;
});

// ---------------------------------------------------------------------------
// Check-ins tab
// ---------------------------------------------------------------------------

async function cargarResumenAsistencias(filtros) {
  const params = new URLSearchParams(filtros);
  [...params.keys()].forEach((k) => {
    if (!params.get(k)) params.delete(k);
  });

  try {
    const res = await fetch(`/api/admin/asistencias/resumen?${params.toString()}`);
    const data = await res.json();
    document.getElementById('checkins-stat-clientes').textContent = data.clientesUnicos;
    document.getElementById('checkins-stat-asistencias').textContent = data.asistencias;
    document.getElementById('checkins-stat-pilates').textContent = data.pilates;
    document.getElementById('checkins-stat-estetica').textContent = data.estetica;
  } catch (err) {
    // Los números de resumen quedan en su último valor si falla.
  }
}

const checkinsConfig = {
  endpoint: '/api/admin/asistencias',
  qInput: document.getElementById('checkins-q'),
  distritoInput: document.getElementById('checkins-distrito'),
  areaInput: document.getElementById('checkins-area'),
  servicioInput: document.getElementById('checkins-servicio'),
  desdeInput: document.getElementById('checkins-desde'),
  hastaInput: document.getElementById('checkins-hasta'),
  scrollContainer: document.getElementById('checkins-scroll'),
  body: document.getElementById('checkins-body'),
  statusEl: document.getElementById('checkins-status'),
  onFiltrosCambian: cargarResumenAsistencias,
  renderRow(a) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtFecha(a.fecha)}</td>
      <td>${a.hora_atencion || ''}</td>
      <td>${a.turno || ''}</td>
      <td>${a.nro_doc}</td>
      <td>${a.paciente || ''}</td>
      <td>${a.distrito || ''}</td>
      <td>${a.area || ''}</td>
      <td>${a.servicio || ''}</td>
      <td><button type="button" class="btn-delete-row" data-delete-asistencia="${a.id}" title="Eliminar asistencia">✕</button></td>
    `;
    return tr;
  },
};

document.getElementById('checkins-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-asistencia]');
  if (!btn) return;
  const id = btn.dataset.deleteAsistencia;
  const confirmado = await mostrarConfirm('¿Eliminar esta asistencia?');
  if (!confirmado) return;

  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/asistencias/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al eliminar');
    btn.closest('tr').remove();
  } catch (err) {
    await mostrarAlert(err.message);
    btn.disabled = false;
  }
});

checkSession();
