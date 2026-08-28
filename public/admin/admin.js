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
  productos: document.getElementById('tab-productos'),
  cotizaciones: document.getElementById('tab-cotizaciones'),
};

// Cada pestaña tiene su propia URL (/admin/usuarios, /admin/productos, ...)
// para que se pueda compartir el link y funcione el botón "atrás".
const TAB_SLUGS = {
  dashboard: 'dashboard',
  usuarios: 'usuarios',
  checkins: 'asistencias',
  productos: 'productos',
  cotizaciones: 'cotizaciones',
};
const SLUG_TABS = Object.fromEntries(Object.entries(TAB_SLUGS).map(([tab, slug]) => [slug, tab]));

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

// Los nombres de producto y familia son texto libre cargado desde el Admin:
// se escapan antes de meterlos en innerHTML.
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtPrecio(v) {
  if (v === null || v === undefined || v === '') return null;
  return Number(v).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMoneda(v) {
  return `S/ ${Number(v || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "hace 3 días" — el semáforo se explica solo si se ve la antigüedad al lado.
function fmtHace(iso) {
  if (!iso) return '';
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 30) return `hace ${dias} días`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? 'hace 1 mes' : `hace ${meses} meses`;
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
  activarTab(tabDesdeUrl());
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

function activarTab(tab) {
  if (!tabPanels[tab]) tab = 'dashboard';
  navTabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  Object.entries(tabPanels).forEach(([nombre, panel]) => panel.classList.toggle('hidden', nombre !== tab));
  return tab;
}

// /admin/productos -> "productos". /admin y /admin/ -> "dashboard".
function tabDesdeUrl() {
  const slug = window.location.pathname.replace(/^\/admin\/?/, '').replace(/\/$/, '');
  return SLUG_TABS[slug] || 'dashboard';
}

navTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = activarTab(btn.dataset.tab);
    const url = `/admin/${TAB_SLUGS[tab]}`;
    if (window.location.pathname !== url) history.pushState({ tab }, '', url);
  });
});

window.addEventListener('popstate', () => {
  if (!adminPanel.classList.contains('hidden')) activarTab(tabDesdeUrl());
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
  configurarProductos();
  configurarCotizaciones();
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

// ---------------------------------------------------------------------------
// Productos (tarifario)
// ---------------------------------------------------------------------------

const productosQ = document.getElementById('productos-q');
const productosCategoria = document.getElementById('productos-categoria');
const productosFamilia = document.getElementById('productos-familia');
const productosBody = document.getElementById('productos-body');
const productosStatus = document.getElementById('productos-status');
const productosScroll = document.getElementById('productos-scroll');
const productosTabla = productosScroll.querySelector('table');

const productoModal = document.getElementById('producto-modal');
const productoForm = document.getElementById('producto-form');
const productoFormMessage = document.getElementById('producto-form-message');
const productoGuardar = document.getElementById('producto-guardar');
const inputProductoSku = document.getElementById('producto-sku');
const inputProductoCategoria = document.getElementById('producto-categoria');
const inputProductoFamilia = document.getElementById('producto-familia');
const inputCategoriaNueva = document.getElementById('producto-categoria-nueva');
const inputFamiliaNueva = document.getElementById('producto-familia-nueva');
const inputProductoNombre = document.getElementById('producto-nombre');
const inputPrecioRegular = document.getElementById('producto-precio-regular');
const inputPrecioOferta = document.getElementById('producto-precio-oferta');
const inputPrecioMax = document.getElementById('producto-precio-max');
const inputProductoPadre = document.getElementById('producto-padre');
const productoPadreWrap = document.getElementById('producto-padre-wrap');
const productoSkuToggle = document.getElementById('producto-sku-toggle');
const radiosTipo = document.querySelectorAll('input[name="producto-tipo"]');

// Ordenamiento por defecto: agrupado por categoría (y dentro, por familia).
const productosState = { offset: 0, hasMore: true, loading: false, sort: 'categoria', dir: 'asc' };
let facetasCache = { categorias: [], familias: [] };
// SKU en edición, o null cuando el formulario está creando un producto nuevo.
let productoEditando = null;
// El SKU se autogenera salvo que el usuario pida escribirlo a mano.
let skuManual = false;

function filtrosProductos() {
  return {
    q: productosQ.value.trim(),
    categoria: productosCategoria.value,
    familia: productosFamilia.value,
    sort: productosState.sort,
    dir: productosState.dir,
  };
}

function paramsProductos(extra = {}) {
  const params = new URLSearchParams({ ...filtrosProductos(), ...extra });
  [...params.keys()].forEach((k) => {
    if (!params.get(k)) params.delete(k);
  });
  return params;
}

function renderProductoRow(p) {
  const tr = document.createElement('tr');
  tr.dataset.sku = p.sku;
  const precio = (v) => {
    const txt = fmtPrecio(v);
    return `<td class="cell-precio${txt ? '' : ' vacio'}">${txt || '—'}</td>`;
  };
  tr.innerHTML = `
    <td class="cell-sku">${esc(p.sku)}</td>
    <td><span class="pill">${esc(p.categoria)}</span></td>
    <td>${esc(p.familia) || ''}</td>
    <td class="cell-producto">${esc(p.nombre)}</td>
    ${precio(p.precio_regular)}
    ${precio(p.precio_oferta)}
    ${precio(p.precio_max_desc)}
    <td>
      <div class="row-actions">
        <button type="button" class="btn-edit-row" data-edit-producto="${esc(p.sku)}" title="Editar producto">✎</button>
        <button type="button" class="btn-delete-row" data-delete-producto="${esc(p.sku)}" title="Eliminar producto">✕</button>
      </div>
    </td>
  `;
  // Los datos crudos viajan con la fila para poder abrir el formulario de
  // edición sin volver a pedirlos al servidor.
  tr._producto = p;
  return tr;
}

async function cargarProductos({ reset }) {
  if (productosState.loading) return;
  if (reset) {
    productosState.offset = 0;
    productosState.hasMore = true;
    productosBody.innerHTML = '';
  }
  if (!productosState.hasMore) return;

  productosState.loading = true;
  productosStatus.textContent = 'Cargando...';

  try {
    const res = await fetch(`/api/admin/productos?${paramsProductos({ offset: String(productosState.offset) })}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al cargar');

    data.rows.forEach((p) => productosBody.appendChild(renderProductoRow(p)));
    productosState.hasMore = data.hasMore;
    productosState.offset += data.rows.length;
    document.getElementById('productos-stat-total').textContent = data.total;
    productosStatus.textContent = productosState.hasMore ? '' : 'No hay más resultados.';
    if (productosState.offset === 0) productosStatus.textContent = 'Sin resultados.';
  } catch (err) {
    productosStatus.textContent = 'Error al cargar.';
  } finally {
    productosState.loading = false;
  }
}

function llenarOpciones(select, valores, etiquetaTodos) {
  const seleccionado = select.value;
  select.innerHTML = `<option value="">${etiquetaTodos}</option>`;
  valores.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
  // Si el valor elegido sigue existiendo, se conserva.
  select.value = valores.includes(seleccionado) ? seleccionado : '';
}

// Las familias mostradas dependen de la categoría elegida (una familia
// pertenece a una sola categoría).
function familiasDeCategoria(categoria) {
  const familias = facetasCache.familias
    .filter((f) => !categoria || f.categoria === categoria)
    .map((f) => f.familia);
  return [...new Set(familias)].sort((a, b) => a.localeCompare(b, 'es'));
}

function refrescarFiltrosProductos() {
  llenarOpciones(productosCategoria, facetasCache.categorias, 'Todas las categorías');
  const familias = familiasDeCategoria(productosCategoria.value);
  llenarOpciones(productosFamilia, familias, 'Todas las familias');
  document.getElementById('productos-stat-categorias').textContent = facetasCache.categorias.length;
  document.getElementById('productos-stat-familias').textContent = familias.length;
}

async function cargarFacetasProductos() {
  try {
    const res = await fetch('/api/admin/productos/facetas');
    facetasCache = await res.json();
    refrescarFiltrosProductos();
  } catch (err) {
    // Los filtros quedan con lo que ya tenían si falla.
  }
}

function marcarColumnaOrdenada() {
  productosTabla.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('sort-asc', th.dataset.sort === productosState.sort && productosState.dir === 'asc');
    th.classList.toggle('sort-desc', th.dataset.sort === productosState.sort && productosState.dir === 'desc');
  });
}

function configurarProductos() {
  const recargar = debounce(() => cargarProductos({ reset: true }), 400);
  productosQ.addEventListener('input', recargar);

  productosCategoria.addEventListener('change', () => {
    llenarOpciones(productosFamilia, familiasDeCategoria(productosCategoria.value), 'Todas las familias');
    document.getElementById('productos-stat-familias').textContent = productosFamilia.options.length - 1;
    cargarProductos({ reset: true });
  });
  productosFamilia.addEventListener('change', () => cargarProductos({ reset: true }));

  productosTabla.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (productosState.sort === col) {
        productosState.dir = productosState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        productosState.sort = col;
        productosState.dir = 'asc';
      }
      marcarColumnaOrdenada();
      cargarProductos({ reset: true });
    });
  });

  productosScroll.addEventListener('scroll', () => {
    if (productosScroll.scrollTop + productosScroll.clientHeight >= productosScroll.scrollHeight - 80) {
      cargarProductos({ reset: false });
    }
  });

  marcarColumnaOrdenada();
  cargarFacetasProductos();
  cargarProductos({ reset: true });
}

// --- SKU autogenerado ------------------------------------------------------

function tipoProductoSeleccionado() {
  return document.querySelector('input[name="producto-tipo"]:checked').value;
}

// Pide al servidor el próximo SKU y lo muestra como preview. El definitivo se
// asigna al guardar, así que acá alcanza con no romper si falla.
async function previsualizarSku() {
  if (skuManual || productoEditando !== null) return;

  const esSub = tipoProductoSeleccionado() === 'sub';
  const params = new URLSearchParams();
  if (esSub) {
    if (!inputProductoPadre.value) {
      inputProductoSku.value = '';
      return;
    }
    params.set('padre', inputProductoPadre.value);
  } else {
    const categoria = categoriaElegida();
    if (!categoria) {
      inputProductoSku.value = '';
      return;
    }
    params.set('categoria', categoria);
    if (familiaElegida()) params.set('familia', familiaElegida());
  }

  try {
    const res = await fetch(`/api/admin/productos/next-sku?${params}`);
    const data = await res.json();
    inputProductoSku.value = res.ok ? data.sku : '';
  } catch (err) {
    inputProductoSku.value = '';
  }
}

const previsualizarSkuDebounced = debounce(previsualizarSku, 300);

// El select de padre lista todos los productos agrupados por categoría, para
// poder elegir de cuál cuelga el sub-producto.
const productosPorSku = new Map();

async function cargarSelectPadres() {
  try {
    const res = await fetch('/api/admin/productos/opciones');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    productosPorSku.clear();
    const seleccionado = inputProductoPadre.value;
    inputProductoPadre.innerHTML = '<option value="">Elegí un producto...</option>';

    let grupo = null;
    data.rows.forEach((p) => {
      productosPorSku.set(p.sku, p);
      if (p.categoria !== grupo) {
        grupo = p.categoria;
        const og = document.createElement('optgroup');
        og.label = grupo;
        inputProductoPadre.appendChild(og);
      }
      const opt = document.createElement('option');
      opt.value = p.sku;
      opt.textContent = `${p.sku} — ${p.nombre}`;
      inputProductoPadre.lastElementChild.appendChild(opt);
    });

    if (productosPorSku.has(seleccionado)) inputProductoPadre.value = seleccionado;
  } catch (err) {
    // El formulario sigue usable para productos nuevos si esto falla.
  }
}

function aplicarTipoProducto() {
  const esSub = tipoProductoSeleccionado() === 'sub';
  productoPadreWrap.classList.toggle('hidden', !esSub);
  if (esSub && inputProductoPadre.value) {
    const padre = productosPorSku.get(inputProductoPadre.value);
    if (padre) {
      poblarCategorias(padre.categoria);
      poblarFamilias(padre.familia || '');
    }
  }
  previsualizarSku();
}

function activarSkuManual(manual) {
  skuManual = manual;
  inputProductoSku.readOnly = !manual;
  inputProductoSku.required = manual;
  productoSkuToggle.textContent = manual ? 'Generarlo automáticamente' : 'Escribirlo a mano';
  if (manual) {
    inputProductoSku.focus();
    inputProductoSku.select();
  } else {
    previsualizarSku();
  }
}

productoSkuToggle.addEventListener('click', () => activarSkuManual(!skuManual));
radiosTipo.forEach((r) => r.addEventListener('change', aplicarTipoProducto));
inputProductoPadre.addEventListener('change', aplicarTipoProducto);

// --- Categoría y familia del formulario ------------------------------------
//
// Son selects (no inputs con datalist): un datalist filtra sus opciones por lo
// que el campo ya tiene escrito, así que una vez elegida una categoría el
// desplegable mostraba solo esa y parecía imposible cambiarla. El select
// siempre muestra todas, y "+ Nueva..." abre un campo de texto aparte.

const VALOR_NUEVA = '__nueva__';

function poblarSelect(select, valores, { etiquetaNueva, etiquetaVacia, seleccionado }) {
  select.innerHTML = '';
  if (etiquetaVacia !== undefined) {
    select.appendChild(new Option(etiquetaVacia, ''));
  }
  // Si el valor actual ya no está en la lista (ej. se renombró la familia), se
  // agrega igual para no perderlo en silencio.
  const opciones = valores.includes(seleccionado) || !seleccionado ? valores : [...valores, seleccionado];
  opciones.forEach((v) => select.appendChild(new Option(v, v)));
  select.appendChild(new Option(etiquetaNueva, VALOR_NUEVA));
  select.value = seleccionado || '';
}

// Valor efectivo: lo elegido en el select, o lo tipeado si se eligió "+ Nueva".
function valorSelectONuevo(select, inputNuevo) {
  return select.value === VALOR_NUEVA ? inputNuevo.value.trim() : select.value;
}

function categoriaElegida() {
  return valorSelectONuevo(inputProductoCategoria, inputCategoriaNueva);
}

function familiaElegida() {
  return valorSelectONuevo(inputProductoFamilia, inputFamiliaNueva);
}

function poblarCategorias(seleccionada) {
  poblarSelect(inputProductoCategoria, facetasCache.categorias, {
    etiquetaVacia: 'Elegí una categoría...',
    etiquetaNueva: '+ Nueva categoría...',
    seleccionado: seleccionada,
  });
  inputCategoriaNueva.classList.add('hidden');
  inputCategoriaNueva.value = '';
}

function poblarFamilias(seleccionada) {
  poblarSelect(inputProductoFamilia, familiasDeCategoria(categoriaElegida()), {
    etiquetaVacia: 'Sin familia',
    etiquetaNueva: '+ Nueva familia...',
    seleccionado: seleccionada,
  });
  inputFamiliaNueva.classList.add('hidden');
  inputFamiliaNueva.value = '';
}

inputProductoCategoria.addEventListener('change', () => {
  const nueva = inputProductoCategoria.value === VALOR_NUEVA;
  inputCategoriaNueva.classList.toggle('hidden', !nueva);
  if (nueva) inputCategoriaNueva.focus();
  // Las familias dependen de la categoría: al cambiarla se re-arma la lista.
  poblarFamilias('');
  previsualizarSku();
});

inputCategoriaNueva.addEventListener('input', () => {
  poblarFamilias('');
  previsualizarSkuDebounced();
});

inputProductoFamilia.addEventListener('change', () => {
  const nueva = inputProductoFamilia.value === VALOR_NUEVA;
  inputFamiliaNueva.classList.toggle('hidden', !nueva);
  if (nueva) inputFamiliaNueva.focus();
  previsualizarSku();
});

inputFamiliaNueva.addEventListener('input', previsualizarSkuDebounced);

// --- Formulario de producto (alta y edición) -------------------------------

function abrirProductoModal(producto) {
  productoEditando = producto ? producto.sku : null;
  document.getElementById('producto-modal-title').textContent = producto ? 'Editar producto' : 'Nuevo producto';
  productoFormMessage.textContent = '';
  productoFormMessage.className = 'message';

  // Al editar, el SKU ya existe: se muestra editable y no se ofrece el
  // selector de tipo (un producto no se convierte en sub-producto renombrando
  // su SKU desde acá).
  document.querySelector('.tipo-producto').classList.toggle('hidden', !!producto);
  productoSkuToggle.classList.toggle('hidden', !!producto);
  if (producto) {
    productoPadreWrap.classList.add('hidden');
    skuManual = true;
    inputProductoSku.readOnly = false;
    inputProductoSku.required = true;
  } else {
    document.querySelector('input[name="producto-tipo"][value="nuevo"]').checked = true;
    inputProductoPadre.value = '';
    productoPadreWrap.classList.add('hidden');
    activarSkuManual(false);
    cargarSelectPadres();
  }

  inputProductoSku.value = producto ? producto.sku : '';
  // En un alta se prefija la categoría que esté filtrada en la tabla, pero
  // sigue siendo cambiable desde el select.
  poblarCategorias(producto ? producto.categoria : productosCategoria.value || '');
  poblarFamilias(producto ? producto.familia || '' : '');
  inputProductoNombre.value = producto ? producto.nombre : '';
  inputPrecioRegular.value = producto && producto.precio_regular != null ? producto.precio_regular : '';
  inputPrecioOferta.value = producto && producto.precio_oferta != null ? producto.precio_oferta : '';
  inputPrecioMax.value = producto && producto.precio_max_desc != null ? producto.precio_max_desc : '';

  productoModal.classList.remove('hidden');
  if (!producto) previsualizarSku();
  inputProductoNombre.focus();
}

function cerrarProductoModal() {
  productoModal.classList.add('hidden');
  productoEditando = null;
}

document.getElementById('btn-nuevo-producto').addEventListener('click', () => abrirProductoModal(null));
document.getElementById('producto-cancelar').addEventListener('click', cerrarProductoModal);
productoModal.addEventListener('click', (e) => {
  if (e.target === productoModal) cerrarProductoModal();
});

productoForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  productoFormMessage.textContent = '';
  productoFormMessage.className = 'message';
  productoGuardar.disabled = true;

  const esSub = productoEditando === null && tipoProductoSeleccionado() === 'sub';
  const payload = {
    // Sin SKU manual, el servidor lo genera al insertar (el del preview puede
    // haber quedado tomado por otro admin en el medio).
    sku: skuManual || productoEditando !== null ? inputProductoSku.value.trim() : '',
    padre: esSub ? inputProductoPadre.value : null,
    categoria: categoriaElegida(),
    familia: familiaElegida(),
    nombre: inputProductoNombre.value.trim(),
    precio_regular: inputPrecioRegular.value,
    precio_oferta: inputPrecioOferta.value,
    precio_max_desc: inputPrecioMax.value,
  };

  if (!payload.categoria) {
    productoFormMessage.textContent = 'Elegí una categoría (o escribí el nombre de la nueva).';
    productoFormMessage.className = 'message error';
    productoGuardar.disabled = false;
    return;
  }

  if (esSub && !payload.padre) {
    productoFormMessage.textContent = 'Elegí el producto padre.';
    productoFormMessage.className = 'message error';
    productoGuardar.disabled = false;
    return;
  }

  const editando = productoEditando !== null;
  const url = editando ? `/api/admin/productos/${encodeURIComponent(productoEditando)}` : '/api/admin/productos';

  try {
    const res = await fetch(url, {
      method: editando ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar');

    cerrarProductoModal();
    await cargarFacetasProductos();
    await cargarProductos({ reset: true });
  } catch (err) {
    productoFormMessage.textContent = err.message;
    productoFormMessage.className = 'message error';
  } finally {
    productoGuardar.disabled = false;
  }
});

productosBody.addEventListener('click', async (e) => {
  const editar = e.target.closest('[data-edit-producto]');
  if (editar) {
    abrirProductoModal(editar.closest('tr')._producto);
    return;
  }

  const borrar = e.target.closest('[data-delete-producto]');
  if (!borrar) return;

  const sku = borrar.dataset.deleteProducto;
  const fila = borrar.closest('tr');
  const confirmado = await mostrarConfirm(`¿Eliminar el producto ${sku} — ${fila._producto.nombre}?`);
  if (!confirmado) return;

  borrar.disabled = true;
  try {
    const res = await fetch(`/api/admin/productos/${encodeURIComponent(sku)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al eliminar');
    fila.remove();
    const statTotal = document.getElementById('productos-stat-total');
    statTotal.textContent = Math.max(0, Number(statTotal.textContent) - 1);
    cargarFacetasProductos();
  } catch (err) {
    await mostrarAlert(err.message);
    borrar.disabled = false;
  }
});

document.getElementById('btn-export-productos').addEventListener('click', () => {
  window.location.href = `/api/admin/productos/export?${paramsProductos()}`;
});

// ---------------------------------------------------------------------------
// Cotizaciones
// ---------------------------------------------------------------------------

const SEMAFORO_LABEL = {
  caliente: 'Caliente',
  tibio: 'Tibio',
  frio: 'Frío',
  vencida: 'Vencida',
  aceptada: 'Aceptada',
  rechazada: 'Rechazada',
};

const cotQ = document.getElementById('cot-q');
const cotSemaforo = document.getElementById('cot-semaforo');
const cotDesde = document.getElementById('cot-desde');
const cotHasta = document.getElementById('cot-hasta');
const cotBody = document.getElementById('cot-body');
const cotStatus = document.getElementById('cot-status');
const cotScroll = document.getElementById('cot-scroll');

const cotizacionModal = document.getElementById('cotizacion-modal');
const cotizacionForm = document.getElementById('cotizacion-form');
const cotizacionFormMessage = document.getElementById('cotizacion-form-message');
const cotizacionGuardar = document.getElementById('cotizacion-guardar');

const cotState = { offset: 0, hasMore: true, loading: false };
// Cotización abierta en el modal (null = alta nueva).
let cotizacionActual = null;
// Cliente elegido y líneas en edición.
let clienteElegido = null;
let itemsEdicion = [];
let mailConfigurado = false;

function filtrosCotizaciones() {
  return {
    q: cotQ.value.trim(),
    semaforo: cotSemaforo.value,
    desde: cotDesde.value,
    hasta: cotHasta.value,
  };
}

function paramsCotizaciones(extra = {}) {
  const params = new URLSearchParams({ ...filtrosCotizaciones(), ...extra });
  [...params.keys()].forEach((k) => {
    if (!params.get(k)) params.delete(k);
  });
  return params;
}

function pillSemaforo(semaforo) {
  return `<span class="semaforo semaforo-${semaforo}">${SEMAFORO_LABEL[semaforo] || semaforo}</span>`;
}

function renderCotizacionRow(c) {
  const tr = document.createElement('tr');
  tr.className = 'fila-clickeable';
  tr.dataset.id = c.id;
  tr.innerHTML = `
    <td class="cell-numero">${esc(c.numero)}</td>
    <td>${esc(c.paciente)}<div class="resultado-meta">${esc(c.documento)}</div></td>
    <td>${esc(c.titulo) || ''}</td>
    <td class="cell-precio">${fmtMoneda(c.total)}</td>
    <td>${fmtFecha(c.created_at)}</td>
    <td>${fmtHace(c.updated_at)}</td>
    <td>${pillSemaforo(c.semaforo)}</td>
    <td><button type="button" class="btn-delete-row" data-delete-cot="${c.id}" title="Eliminar cotización">✕</button></td>
  `;
  return tr;
}

async function cargarCotizaciones({ reset }) {
  if (cotState.loading) return;
  if (reset) {
    cotState.offset = 0;
    cotState.hasMore = true;
    cotBody.innerHTML = '';
    cargarResumenCotizaciones();
  }
  if (!cotState.hasMore) return;

  cotState.loading = true;
  cotStatus.textContent = 'Cargando...';

  try {
    const res = await fetch(`/api/admin/cotizaciones?${paramsCotizaciones({ offset: String(cotState.offset) })}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al cargar');

    data.rows.forEach((c) => cotBody.appendChild(renderCotizacionRow(c)));
    cotState.hasMore = data.hasMore;
    cotState.offset += data.rows.length;
    cotStatus.textContent = cotState.hasMore ? '' : 'No hay más resultados.';
    if (cotState.offset === 0) cotStatus.textContent = 'Sin cotizaciones.';
  } catch (err) {
    cotStatus.textContent = 'Error al cargar.';
  } finally {
    cotState.loading = false;
  }
}

async function cargarResumenCotizaciones() {
  try {
    const res = await fetch(`/api/admin/cotizaciones/resumen?${paramsCotizaciones()}`);
    const data = await res.json();
    if (!res.ok) return;
    document.getElementById('cot-stat-total').textContent = data.total;
    document.getElementById('cot-stat-caliente').textContent = data.porSemaforo.caliente;
    document.getElementById('cot-stat-seguimiento').textContent = data.porSemaforo.tibio + data.porSemaforo.frio;
    document.getElementById('cot-stat-monto').textContent = fmtMoneda(data.montoAceptado);
  } catch (err) {
    // Las stat cards quedan con su último valor.
  }
}

function configurarCotizaciones() {
  const recargar = debounce(() => cargarCotizaciones({ reset: true }), 400);
  cotQ.addEventListener('input', recargar);
  [cotSemaforo, cotDesde, cotHasta].forEach((el) => el.addEventListener('change', () => cargarCotizaciones({ reset: true })));

  cotScroll.addEventListener('scroll', () => {
    if (cotScroll.scrollTop + cotScroll.clientHeight >= cotScroll.scrollHeight - 80) {
      cargarCotizaciones({ reset: false });
    }
  });

  // productosPorSku alimenta el buscador de ítems del modal, así que el
  // catálogo tiene que estar cargado antes de abrir cualquier cotización.
  cargarSelectPadres();

  fetch('/api/admin/cotizaciones/config')
    .then((r) => r.json())
    .then((cfg) => {
      mailConfigurado = Boolean(cfg.mailConfigurado);
    })
    .catch(() => {});

  cargarCotizaciones({ reset: true });
}

// Clic en la fila -> detalle; clic en la ✕ -> borrar.
cotBody.addEventListener('click', async (e) => {
  const borrar = e.target.closest('[data-delete-cot]');
  if (borrar) {
    e.stopPropagation();
    const id = borrar.dataset.deleteCot;
    const confirmado = await mostrarConfirm('¿Eliminar esta cotización? Se borran también sus ítems y notas.');
    if (!confirmado) return;
    borrar.disabled = true;
    try {
      const res = await fetch(`/api/admin/cotizaciones/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al eliminar');
      borrar.closest('tr').remove();
      cargarResumenCotizaciones();
    } catch (err) {
      await mostrarAlert(err.message);
      borrar.disabled = false;
    }
    return;
  }

  const fila = e.target.closest('tr[data-id]');
  if (fila) abrirCotizacion(fila.dataset.id);
});

// --- Buscador de clientes --------------------------------------------------

const cotClienteBuscar = document.getElementById('cot-cliente-buscar');
const cotClienteResultados = document.getElementById('cot-cliente-resultados');
const cotClienteElegido = document.getElementById('cot-cliente-elegido');

function mostrarClienteElegido(cliente) {
  clienteElegido = cliente;
  if (!cliente) {
    cotClienteElegido.classList.add('hidden');
    cotClienteBuscar.parentElement.classList.remove('hidden');
    return;
  }
  document.getElementById('cot-cliente-nombre').textContent = cliente.paciente;
  document.getElementById('cot-cliente-meta').textContent = [
    `${cliente.tipo_doc || 'Doc'}: ${cliente.documento}`,
    cliente.celular,
    cliente.correo,
  ]
    .filter(Boolean)
    .join('  ·  ');
  cotClienteElegido.classList.remove('hidden');
  cotClienteBuscar.parentElement.classList.add('hidden');
  cotClienteResultados.classList.add('hidden');
}

const buscarClientes = debounce(async () => {
  const q = cotClienteBuscar.value.trim();
  if (q.length < 2) {
    cotClienteResultados.classList.add('hidden');
    return;
  }
  try {
    const res = await fetch(`/api/admin/clientes?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    cotClienteResultados.innerHTML = '';
    if (!data.rows.length) {
      cotClienteResultados.innerHTML = '<p class="resultado-vacio">Sin resultados. Podés registrarlo con "+ Registrar usuario".</p>';
    } else {
      data.rows.slice(0, 20).forEach((c) => {
        const div = document.createElement('div');
        div.className = 'resultado-item';
        div.dataset.documento = c.documento;
        div.innerHTML = `<strong>${esc(c.paciente)}</strong><div class="resultado-meta">${esc(c.tipo_doc || 'Doc')}: ${esc(c.documento)}${c.celular ? ' · ' + esc(c.celular) : ''}</div>`;
        div._cliente = c;
        cotClienteResultados.appendChild(div);
      });
    }
    cotClienteResultados.classList.remove('hidden');
  } catch (err) {
    cotClienteResultados.classList.add('hidden');
  }
}, 300);

cotClienteBuscar.addEventListener('input', buscarClientes);
cotClienteResultados.addEventListener('click', (e) => {
  const item = e.target.closest('.resultado-item');
  if (item) mostrarClienteElegido(item._cliente);
});
document.getElementById('btn-cambiar-cliente').addEventListener('click', () => {
  mostrarClienteElegido(null);
  cotClienteBuscar.value = '';
  cotClienteBuscar.focus();
});

// --- Ítems -----------------------------------------------------------------

const cotItemBuscar = document.getElementById('cot-item-buscar');
const cotItemResultados = document.getElementById('cot-item-resultados');
const cotItemPrecio = document.getElementById('cot-item-precio');
const cotItemsBody = document.getElementById('cot-items-body');

// El precio propuesto sale del tipo elegido, con fallback: no todos los
// productos tienen los 3 precios (Pilates y Tienda no tienen máx. descuento).
function precioDeProducto(producto, tipo) {
  const porTipo = {
    regular: producto.precio_regular,
    oferta: producto.precio_oferta,
    max_desc: producto.precio_max_desc,
  };
  return porTipo[tipo] ?? producto.precio_oferta ?? producto.precio_regular ?? 0;
}

function totalItems() {
  return itemsEdicion.reduce((acc, it) => acc + it.cantidad * it.precio_unitario, 0);
}

function renderItems() {
  cotItemsBody.innerHTML = '';
  itemsEdicion.forEach((item, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="cell-sku">${esc(item.sku) || '—'}</td>
      <td class="cell-producto">${esc(item.nombre)}</td>
      <td class="cell-precio"><input type="number" class="input-cantidad" min="1" step="1" value="${item.cantidad}" data-campo="cantidad" data-i="${i}" /></td>
      <td class="cell-precio"><input type="number" class="input-precio" min="0" step="0.01" value="${item.precio_unitario}" data-campo="precio" data-i="${i}" /></td>
      <td class="cell-precio">${fmtMoneda(item.cantidad * item.precio_unitario)}</td>
      <td><button type="button" class="btn-delete-row" data-quitar="${i}" title="Quitar ítem">✕</button></td>
    `;
    cotItemsBody.appendChild(tr);
  });
  document.getElementById('cot-items-vacio').classList.toggle('hidden', itemsEdicion.length > 0);
  document.getElementById('cot-total').textContent = fmtMoneda(totalItems());
}

cotItemsBody.addEventListener('input', (e) => {
  const campo = e.target.dataset.campo;
  if (!campo) return;
  const i = Number(e.target.dataset.i);
  if (campo === 'cantidad') {
    itemsEdicion[i].cantidad = Math.max(1, Math.floor(Number(e.target.value) || 1));
  } else {
    itemsEdicion[i].precio_unitario = Math.max(0, Number(e.target.value) || 0);
  }
  // Se recalculan importes y total sin re-renderizar la fila que se está
  // editando (perdería el foco del input).
  const fila = e.target.closest('tr');
  fila.children[4].textContent = fmtMoneda(itemsEdicion[i].cantidad * itemsEdicion[i].precio_unitario);
  document.getElementById('cot-total').textContent = fmtMoneda(totalItems());
});

cotItemsBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-quitar]');
  if (!btn) return;
  itemsEdicion.splice(Number(btn.dataset.quitar), 1);
  renderItems();
});

const buscarProductos = debounce(() => {
  const q = cotItemBuscar.value.trim().toLowerCase();
  if (q.length < 2) {
    cotItemResultados.classList.add('hidden');
    return;
  }
  const encontrados = [...productosPorSku.values()]
    .filter((p) => p.sku.toLowerCase().includes(q) || p.nombre.toLowerCase().includes(q))
    .slice(0, 20);

  cotItemResultados.innerHTML = '';
  if (!encontrados.length) {
    cotItemResultados.innerHTML = '<p class="resultado-vacio">Sin productos que coincidan.</p>';
  } else {
    encontrados.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'resultado-item';
      div.innerHTML = `<strong>${esc(p.nombre)}</strong><div class="resultado-meta">${esc(p.sku)} · ${esc(p.categoria)}${p.familia ? ' · ' + esc(p.familia) : ''} · ${fmtMoneda(precioDeProducto(p, cotItemPrecio.value))}</div>`;
      div._producto = p;
      cotItemResultados.appendChild(div);
    });
  }
  cotItemResultados.classList.remove('hidden');
}, 250);

cotItemBuscar.addEventListener('input', buscarProductos);
cotItemPrecio.addEventListener('change', buscarProductos);

cotItemResultados.addEventListener('click', (e) => {
  const div = e.target.closest('.resultado-item');
  if (!div || !div._producto) return;
  const p = div._producto;
  const tipo = cotItemPrecio.value;

  // Si el producto ya está en la lista, se suma una unidad en vez de duplicar.
  const existente = itemsEdicion.find((it) => it.sku === p.sku);
  if (existente) {
    existente.cantidad += 1;
  } else {
    itemsEdicion.push({
      sku: p.sku,
      nombre: p.nombre,
      cantidad: 1,
      precio_unitario: precioDeProducto(p, tipo),
      tipo_precio: tipo,
    });
  }
  cotItemBuscar.value = '';
  cotItemResultados.classList.add('hidden');
  renderItems();
});

// --- Modal de cotización ---------------------------------------------------

function limpiarFormularioCotizacion() {
  cotizacionFormMessage.textContent = '';
  cotizacionFormMessage.className = 'message';
  document.getElementById('cot-titulo').value = '';
  document.getElementById('cot-validez').value = 30;
  document.getElementById('cot-estado').value = 'abierta';
  document.getElementById('cot-observaciones').value = '';
  document.getElementById('cot-nota-texto').value = '';
  cotClienteBuscar.value = '';
  cotItemBuscar.value = '';
  cotClienteResultados.classList.add('hidden');
  cotItemResultados.classList.add('hidden');
}

function renderNotas(notas) {
  const lista = document.getElementById('cot-notas-lista');
  lista.innerHTML = '';
  if (!notas.length) {
    lista.innerHTML = '<li class="resultado-vacio">Sin notas todavía.</li>';
    return;
  }
  notas.forEach((n) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nota-fecha">${fmtFechaHora(n.created_at)}</span><span class="nota-texto">${esc(n.texto)}</span>`;
    lista.appendChild(li);
  });
}

function pintarCotizacion(cotizacion) {
  cotizacionActual = cotizacion;
  const esNueva = !cotizacion;

  document.getElementById('cotizacion-modal-title').textContent = esNueva
    ? 'Nueva cotización'
    : `Cotización ${cotizacion.numero}`;

  const pill = document.getElementById('cotizacion-semaforo');
  pill.classList.toggle('hidden', esNueva);
  if (!esNueva) {
    pill.className = `semaforo semaforo-${cotizacion.semaforo}`;
    pill.textContent = `${SEMAFORO_LABEL[cotizacion.semaforo]} · ${fmtHace(cotizacion.updated_at)}`;
  }

  document.getElementById('cot-bloque-notas').classList.toggle('hidden', esNueva);
  document.getElementById('cot-acciones-doc').classList.toggle('hidden', esNueva);

  if (esNueva) {
    limpiarFormularioCotizacion();
    itemsEdicion = [];
    mostrarClienteElegido(null);
  } else {
    cotizacionFormMessage.textContent = '';
    cotizacionFormMessage.className = 'message';
    document.getElementById('cot-titulo').value = cotizacion.titulo || '';
    document.getElementById('cot-validez').value = cotizacion.validez_dias;
    document.getElementById('cot-estado').value = cotizacion.estado;
    document.getElementById('cot-observaciones').value = cotizacion.observaciones || '';
    itemsEdicion = cotizacion.items.map((i) => ({ ...i }));
    mostrarClienteElegido({
      documento: cotizacion.documento,
      paciente: cotizacion.paciente,
      tipo_doc: cotizacion.tipo_doc,
      celular: cotizacion.celular,
      correo: cotizacion.correo,
    });
    renderNotas(cotizacion.notas);
  }

  renderItems();
  cotizacionModal.classList.remove('hidden');
}

async function abrirCotizacion(id) {
  try {
    // Se refresca el catálogo por si cambió el tarifario desde que cargó la
    // página; los precios ya cotizados no se tocan (quedan congelados).
    await cargarSelectPadres();
    const res = await fetch(`/api/admin/cotizaciones/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al abrir la cotización');
    pintarCotizacion(data);
  } catch (err) {
    await mostrarAlert(err.message);
  }
}

function cerrarCotizacionModal() {
  cotizacionModal.classList.add('hidden');
  cotizacionActual = null;
}

document.getElementById('btn-nueva-cotizacion').addEventListener('click', () => {
  cargarSelectPadres(); // refresca productosPorSku, que alimenta el buscador de ítems
  pintarCotizacion(null);
});
document.getElementById('cotizacion-cancelar').addEventListener('click', cerrarCotizacionModal);
cotizacionModal.addEventListener('click', (e) => {
  if (e.target === cotizacionModal) cerrarCotizacionModal();
});

cotizacionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  cotizacionFormMessage.textContent = '';
  cotizacionFormMessage.className = 'message';

  if (!clienteElegido) {
    cotizacionFormMessage.textContent = 'Elegí un cliente para la cotización.';
    cotizacionFormMessage.className = 'message error';
    return;
  }
  if (!itemsEdicion.length) {
    cotizacionFormMessage.textContent = 'Agregá al menos un ítem.';
    cotizacionFormMessage.className = 'message error';
    return;
  }

  cotizacionGuardar.disabled = true;
  const payload = {
    documento: clienteElegido.documento,
    titulo: document.getElementById('cot-titulo').value.trim(),
    validez_dias: Number(document.getElementById('cot-validez').value),
    estado: document.getElementById('cot-estado').value,
    observaciones: document.getElementById('cot-observaciones').value.trim(),
    items: itemsEdicion,
  };

  const editando = cotizacionActual !== null;
  const url = editando ? `/api/admin/cotizaciones/${cotizacionActual.id}` : '/api/admin/cotizaciones';

  try {
    const res = await fetch(url, {
      method: editando ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar');

    // Se queda abierta mostrando la cotización guardada, para poder imprimirla
    // o mandarla sin tener que volver a abrirla.
    pintarCotizacion(data.cotizacion);
    cargarCotizaciones({ reset: true });
  } catch (err) {
    cotizacionFormMessage.textContent = err.message;
    cotizacionFormMessage.className = 'message error';
  } finally {
    cotizacionGuardar.disabled = false;
  }
});

document.getElementById('btn-agregar-nota').addEventListener('click', async () => {
  const input = document.getElementById('cot-nota-texto');
  const texto = input.value.trim();
  if (!texto || !cotizacionActual) return;

  try {
    const res = await fetch(`/api/admin/cotizaciones/${cotizacionActual.id}/notas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al agregar la nota');
    input.value = '';
    pintarCotizacion(data.cotizacion);
    cargarCotizaciones({ reset: true });
  } catch (err) {
    await mostrarAlert(err.message);
  }
});

// --- Imprimir / PDF / correo -----------------------------------------------

document.getElementById('btn-cot-imprimir').addEventListener('click', () => {
  if (cotizacionActual) window.open(`/api/admin/cotizaciones/${cotizacionActual.id}/pdf`, '_blank');
});

document.getElementById('btn-cot-pdf').addEventListener('click', () => {
  if (cotizacionActual) window.location.href = `/api/admin/cotizaciones/${cotizacionActual.id}/pdf?descargar=1`;
});

const emailModal = document.getElementById('email-modal');
const emailForm = document.getElementById('email-form');
const emailMessage = document.getElementById('email-form-message');
const emailEnviar = document.getElementById('email-enviar');

document.getElementById('btn-cot-email').addEventListener('click', async () => {
  if (!cotizacionActual) return;
  if (!mailConfigurado) {
    await mostrarAlert('El envío por correo no está configurado en el servidor (faltan SMTP_HOST, SMTP_USER y SMTP_PASS). Mientras tanto podés descargar el PDF y mandarlo a mano.');
    return;
  }
  emailMessage.textContent = '';
  emailMessage.className = 'message';
  document.getElementById('email-destinatario').value = cotizacionActual.correo || '';
  const saludo = cotizacionActual.apodo || (cotizacionActual.paciente || '').split(' ')[0];
  document.getElementById('email-mensaje').value =
    `Hola ${saludo},\n\nTe compartimos la cotización ${cotizacionActual.numero} que preparamos para vos.\n\n¡Gracias por elegir Infinia!`;
  emailModal.classList.remove('hidden');
});

document.getElementById('email-cancelar').addEventListener('click', () => emailModal.classList.add('hidden'));
emailModal.addEventListener('click', (e) => {
  if (e.target === emailModal) emailModal.classList.add('hidden');
});

emailForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  emailMessage.textContent = '';
  emailMessage.className = 'message';
  emailEnviar.disabled = true;

  try {
    const res = await fetch(`/api/admin/cotizaciones/${cotizacionActual.id}/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destinatario: document.getElementById('email-destinatario').value.trim(),
        mensaje: document.getElementById('email-mensaje').value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al enviar');
    emailModal.classList.add('hidden');
    pintarCotizacion(data.cotizacion);
    await mostrarAlert(`Cotización enviada a ${data.destinatario}.`);
  } catch (err) {
    emailMessage.textContent = err.message;
    emailMessage.className = 'message error';
  } finally {
    emailEnviar.disabled = false;
  }
});

// --- Alta rápida de cliente ------------------------------------------------

const clienteModal = document.getElementById('cliente-modal');
const clienteForm = document.getElementById('cliente-form');
const clienteMessage = document.getElementById('cliente-form-message');
const clienteGuardar = document.getElementById('cliente-guardar');

document.getElementById('btn-registrar-cliente').addEventListener('click', () => {
  clienteMessage.textContent = '';
  clienteMessage.className = 'message';
  clienteForm.reset();
  const selectDistrito = document.getElementById('cli-distrito');
  if (!selectDistrito.options.length) {
    selectDistrito.appendChild(new Option('—', ''));
    distritosCache.forEach((d) => selectDistrito.appendChild(new Option(d, d)));
  }
  // Arranca con lo que ya se haya tipeado en el buscador, si parece documento.
  const buscado = cotClienteBuscar.value.trim();
  if (/^[A-Za-z0-9]+$/.test(buscado)) document.getElementById('cli-documento').value = buscado;
  clienteModal.classList.remove('hidden');
});

document.getElementById('cliente-cancelar').addEventListener('click', () => clienteModal.classList.add('hidden'));
clienteModal.addEventListener('click', (e) => {
  if (e.target === clienteModal) clienteModal.classList.add('hidden');
});

clienteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clienteMessage.textContent = '';
  clienteMessage.className = 'message';

  const tipoDoc = document.getElementById('cli-tipo-doc').value;
  const documento = document.getElementById('cli-documento').value.trim();

  // Misma validación de formato que usa el formulario público y el servidor.
  if (window.DocumentoValidation && !window.DocumentoValidation.validarFormatoDocumento(tipoDoc, documento)) {
    clienteMessage.textContent = `El documento no tiene un formato válido para ${tipoDoc}.`;
    clienteMessage.className = 'message error';
    return;
  }

  clienteGuardar.disabled = true;
  try {
    const res = await fetch('/api/clientes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        DOCUMENTO: documento,
        TIPO_DOC: tipoDoc,
        PACIENTE: document.getElementById('cli-paciente').value.trim(),
        APODO: document.getElementById('cli-apodo').value.trim(),
        CELULAR: document.getElementById('cli-celular').value.trim(),
        CORREO: document.getElementById('cli-correo').value.trim(),
        DISTRITO: document.getElementById('cli-distrito').value,
        SEXO: document.getElementById('cli-sexo').value,
        F_NACIMIENTO: document.getElementById('cli-nacimiento').value || null,
        DIRECCION: document.getElementById('cli-direccion').value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al registrar');

    clienteModal.classList.add('hidden');
    mostrarClienteElegido(data.cliente);
  } catch (err) {
    clienteMessage.textContent = err.message;
    clienteMessage.className = 'message error';
  } finally {
    clienteGuardar.disabled = false;
  }
});

checkSession();

