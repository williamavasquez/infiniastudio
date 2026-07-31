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

  distritosCache = await fetch('/api/distritos').then((r) => r.json());

  llenarSelect(document.getElementById('usuarios-distrito'), distritosCache);
  llenarSelect(document.getElementById('checkins-distrito'), distritosCache);

  cargarDashboard();
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

async function cargarDashboard() {
  const res = await fetch('/api/admin/dashboard');
  const data = await res.json();

  document.getElementById('stat-total-clientes').textContent = data.totalClientes;
  document.getElementById('stat-checkins-dia').textContent = data.checkinsUltimoDia;
  document.getElementById('stat-checkins-semana').textContent = data.checkinsUltimaSemana;

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
      <td>${c.distrito || ''}</td>
      <td>${c.celular || ''}</td>
      <td>${c.correo || ''}</td>
      <td>${fmtFechaHora(c.fecha_creacion)}</td>
    `;
    return tr;
  },
};

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
    `;
    return tr;
  },
};

checkSession();
