// ---------------------------------------------------------------------------
// Inventario: lista con stock y semáforo, formulario de producto, categorías,
// proveedores, edición masiva y conteo inicial. Se carga después de admin.js
// y usa sus helpers (esc, debounce, mostrarConfirm, mostrarAlert...).
// ---------------------------------------------------------------------------

const invQ = document.getElementById('inventario-q');
const invFiltroCategoria = document.getElementById('inventario-categoria');
const invFiltroFamilia = document.getElementById('inventario-familia');
const invFiltroProveedor = document.getElementById('inventario-proveedor');
const invBajoMinimo = document.getElementById('inventario-bajo-minimo');
const invNegativo = document.getElementById('inventario-negativo');
const invDescontinuados = document.getElementById('inventario-descontinuados');
const invBody = document.getElementById('inventario-body');
const invStatus = document.getElementById('inventario-status');
const invScroll = document.getElementById('inventario-scroll');
const invTabla = invScroll.querySelector('table');

const invState = { offset: 0, hasMore: true, loading: false, total: 0, sort: 'categoria', dir: 'asc' };
let invCategorias = []; // plano: { id, nombre, parent_id, activo, productos }
let invProveedores = []; // { id, nombre, ruc, contacto, telefono, correo, activo }

const SEMAFORO_INV_LABEL = { rojo: 'Bajo mínimo', amarillo: 'Por agotarse', verde: 'OK' };

function fmtCantidad(v) {
  return Number(v || 0).toLocaleString('es-PE', { maximumFractionDigits: 4 });
}

// El costo promedio es por unidad base (puede ser 0.0833), por eso más decimales.
function fmtCosto(v) {
  return `S/ ${Number(v || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

async function invApi(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Error'), { data });
  return data;
}

// --- Categorías y proveedores (alimentan filtros y formularios) -------------

const invRaices = () => invCategorias.filter((c) => !c.parent_id);
const invHijas = (padreId) => invCategorias.filter((c) => c.parent_id === Number(padreId));

// Opciones "Categoría" y "Categoría › Familia" activas; `seleccionado` se
// conserva aunque esté desactivada (un producto puede seguir apuntando a ella).
function opcionesCategoriaFamilia(seleccionado) {
  const visible = (c) => c.activo || c.id === seleccionado;
  return invRaices()
    .filter(visible)
    .flatMap((c) => [
      `<option value="${c.id}">${esc(c.nombre)}</option>`,
      ...invHijas(c.id).filter(visible).map((h) => `<option value="${h.id}">${esc(c.nombre)} › ${esc(h.nombre)}</option>`),
    ])
    .join('');
}

function opcionesProveedor(seleccionado) {
  return invProveedores
    .filter((p) => p.activo || p.id === seleccionado)
    .map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`)
    .join('');
}

function refrescarFiltrosInventario() {
  const cat = invFiltroCategoria.value;
  const fam = invFiltroFamilia.value;
  const prov = invFiltroProveedor.value;
  invFiltroCategoria.innerHTML =
    '<option value="">Todas las categorías</option>' +
    invRaices().map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
  invFiltroCategoria.value = cat;
  const familias = cat ? invHijas(cat) : invCategorias.filter((c) => c.parent_id);
  invFiltroFamilia.innerHTML =
    '<option value="">Todas las familias</option>' + familias.map((f) => `<option value="${f.id}">${esc(f.nombre)}</option>`).join('');
  invFiltroFamilia.value = familias.some((f) => String(f.id) === fam) ? fam : '';
  invFiltroProveedor.innerHTML = '<option value="">Todos los proveedores</option>' + opcionesProveedor(null);
  invFiltroProveedor.value = prov;

  document.getElementById('inventario-bulk-categoria').innerHTML = opcionesCategoriaFamilia(null);
  document.getElementById('inventario-bulk-proveedor').innerHTML = opcionesProveedor(null);
}

async function cargarCatalogoInventario() {
  const [cats, provs] = await Promise.all([invApi('/api/admin/inventario/categorias'), invApi('/api/admin/inventario/proveedores')]);
  invCategorias = cats.rows;
  invProveedores = provs.rows;
  refrescarFiltrosInventario();
}

// --- Lista ------------------------------------------------------------------

function invFiltros() {
  return {
    q: invQ.value.trim(),
    categoria_id: invFiltroCategoria.value,
    familia_id: invFiltroFamilia.value,
    proveedor_id: invFiltroProveedor.value,
    bajo_minimo: invBajoMinimo.checked ? '1' : '',
    stock_negativo: invNegativo.checked ? '1' : '',
    descontinuados: invDescontinuados.checked ? '1' : '',
    sort: invState.sort,
    dir: invState.dir,
  };
}

function invParams(extra = {}) {
  const params = new URLSearchParams({ ...invFiltros(), ...extra });
  [...params.keys()].forEach((k) => {
    if (!params.get(k)) params.delete(k);
  });
  return params;
}

function renderInventarioRow(p) {
  const tr = document.createElement('tr');
  tr.dataset.id = p.id;
  if (p.discontinuado_at) tr.classList.add('descontinuado');
  const catFam = p.familia ? `${esc(p.categoria)} › ${esc(p.familia)}` : esc(p.categoria || '');
  const proveedores = p.proveedores
    .map((s) => (s.sku_proveedor ? `${esc(s.proveedor)} (${esc(s.sku_proveedor)})` : esc(s.proveedor)))
    .join('<br>');
  tr.innerHTML = `
    <td class="cell-check"><input type="checkbox" data-sel="${p.id}" ${invSel.ids.has(p.id) || invSel.todos ? 'checked' : ''} /></td>
    <td class="cell-sku">${esc(p.sku)}</td>
    <td class="cell-servicio">${esc(p.nombre)}${p.discontinuado_at ? ' <span class="pill">Descontinuado</span>' : ''}</td>
    <td>${catFam}</td>
    <td class="cell-precio${p.stock < 0 ? ' stock-negativo' : ''}">${fmtCantidad(p.stock)} ${esc(p.unidad_base)}</td>
    <td class="cell-precio${p.stock_minimo === null ? ' vacio' : ''}">${p.stock_minimo === null ? '—' : fmtCantidad(p.stock_minimo)}</td>
    <td>${p.semaforo ? `<span class="semaforo semaforo-${p.semaforo}">${SEMAFORO_INV_LABEL[p.semaforo]}</span>` : '—'}</td>
    <td class="cell-precio">${fmtCosto(p.costo_promedio)}</td>
    <td>${proveedores || '—'}</td>
    <td>
      <div class="row-actions">
        <button type="button" class="btn-edit-row" data-edit-inv="${p.id}" title="Editar producto">✎</button>
        <button type="button" class="btn-delete-row" data-delete-inv="${p.id}" title="Eliminar producto">✕</button>
      </div>
    </td>
  `;
  tr._producto = p;
  return tr;
}

async function cargarInventario({ reset }) {
  if (invState.loading) return;
  if (reset) {
    invState.offset = 0;
    invState.hasMore = true;
    invBody.innerHTML = '';
    limpiarSeleccionInv();
  }
  if (!invState.hasMore) return;

  invState.loading = true;
  invStatus.textContent = 'Cargando...';
  try {
    const data = await invApi(`/api/admin/inventario?${invParams({ offset: String(invState.offset) })}`);
    data.rows.forEach((p) => invBody.appendChild(renderInventarioRow(p)));
    invState.hasMore = data.hasMore;
    invState.offset += data.rows.length;
    invState.total = data.total;
    document.getElementById('inventario-stat-total').textContent = data.total;
    invStatus.textContent = invState.hasMore ? '' : 'No hay más resultados.';
    if (invState.offset === 0) invStatus.textContent = 'Sin resultados.';
    actualizarBarraBulk();
  } catch (err) {
    invStatus.textContent = 'Error al cargar.';
  } finally {
    invState.loading = false;
  }
}

// --- Selección y edición masiva --------------------------------------------

// `todos` = "seleccionar todos los que coinciden con el filtro": en ese modo
// no se mandan ids, se manda el filtro y el servidor resuelve la lista.
const invSel = { ids: new Set(), todos: false };

function limpiarSeleccionInv() {
  invSel.ids.clear();
  invSel.todos = false;
  document.getElementById('inventario-check-todos').checked = false;
  actualizarBarraBulk();
}

function actualizarBarraBulk() {
  const cantidad = invSel.todos ? invState.total : invSel.ids.size;
  const barra = document.getElementById('inventario-bulk');
  barra.classList.toggle('hidden', cantidad === 0);
  document.getElementById('inventario-bulk-count').textContent = `${cantidad} seleccionado(s)`;
  const btnTodos = document.getElementById('inventario-bulk-todos');
  // Solo ofrece "todos los que coinciden" si hay más que los marcados.
  btnTodos.classList.toggle('hidden', invSel.todos || invState.total <= invSel.ids.size);
  btnTodos.textContent = `Seleccionar los ${invState.total} que coinciden con el filtro`;
}

function actualizarValorBulk() {
  const accion = document.getElementById('inventario-bulk-accion').value;
  document.getElementById('inventario-bulk-categoria').classList.toggle('hidden', accion !== 'categoria');
  document.getElementById('inventario-bulk-proveedor').classList.toggle('hidden', accion !== 'proveedor');
  document.getElementById('inventario-bulk-minimo').classList.toggle('hidden', accion !== 'minimo');
}

async function aplicarBulk() {
  const accion = document.getElementById('inventario-bulk-accion').value;
  const valor = {
    categoria: () => document.getElementById('inventario-bulk-categoria').value,
    proveedor: () => document.getElementById('inventario-bulk-proveedor').value,
    minimo: () => document.getElementById('inventario-bulk-minimo').value,
  }[accion]?.();
  if ((accion === 'categoria' || accion === 'proveedor') && !valor) return mostrarAlert('Elegí una opción.');

  const cantidad = invSel.todos ? invState.total : invSel.ids.size;
  const detalle = {
    categoria: 'cambiar la categoría / familia',
    proveedor: 'reemplazar sus proveedores por el elegido (se conservan los SKU de proveedor solo si ya lo tenían)',
    minimo: valor === '' ? 'quitar el stock mínimo' : `fijar el stock mínimo en ${valor}`,
    descontinuar: 'descontinuar',
    reactivar: 'reactivar',
  }[accion];
  if (!(await mostrarConfirm(`¿${detalle[0].toUpperCase() + detalle.slice(1)} de ${cantidad} producto(s)?`))) return;

  try {
    const body = { accion, valor, ...(invSel.todos ? { filtro: invFiltros() } : { ids: [...invSel.ids] }) };
    const data = await invApi('/api/admin/inventario/bulk', 'POST', body);
    await cargarCatalogoInventario();
    await cargarInventario({ reset: true });
    await mostrarAlert(`Listo: ${data.actualizados} producto(s) actualizados.`);
  } catch (err) {
    await mostrarAlert(err.message);
  }
}

// --- Formulario de producto -------------------------------------------------

const invModal = document.getElementById('inv-modal');
const invForm = document.getElementById('inv-form');
const invFormMessage = document.getElementById('inv-form-message');
const invGuardar = document.getElementById('inv-guardar');
const invSku = document.getElementById('inv-sku');
const invSkuToggle = document.getElementById('inv-sku-toggle');
const invCategoria = document.getElementById('inv-categoria');
const invFamilia = document.getElementById('inv-familia');
const invProvFilas = document.getElementById('inv-proveedores-filas');

let invEditando = null; // id en edición, o null si es alta
let invSkuManual = false;
let invSkusServicios = null; // se pide una sola vez, al primer uso

// La categoría del producto es la familia si la tiene, o la categoría si no.
function categoriaIdElegida() {
  return invFamilia.value || invCategoria.value || '';
}

function poblarFamiliasForm(familiaId) {
  const hijas = invCategoria.value ? invHijas(invCategoria.value) : [];
  invFamilia.innerHTML =
    '<option value="">Sin familia</option>' +
    hijas.filter((h) => h.activo || h.id === familiaId).map((h) => `<option value="${h.id}">${esc(h.nombre)}</option>`).join('');
  invFamilia.value = familiaId || '';
}

async function previsualizarSkuInv() {
  if (invSkuManual || invEditando !== null) return;
  const id = categoriaIdElegida();
  if (!id) {
    invSku.value = '';
    return;
  }
  try {
    invSku.value = (await invApi(`/api/admin/inventario/next-sku?categoria_id=${id}`)).sku;
  } catch {
    invSku.value = '';
  }
}

async function activarSkuManualInv(manual) {
  invSkuManual = manual;
  invSku.readOnly = !manual;
  invSkuToggle.textContent = manual ? 'Generarlo automáticamente' : 'Escribirlo o elegir el de un servicio';
  if (manual) {
    invSku.value = '';
    invSku.focus();
    if (!invSkusServicios) {
      try {
        invSkusServicios = (await invApi('/api/admin/inventario/skus-servicios')).rows;
        document.getElementById('inv-skus-servicios').innerHTML = invSkusServicios
          .map((s) => `<option value="${esc(s.sku)}">${esc(s.nombre)}</option>`)
          .join('');
      } catch {
        invSkusServicios = [];
      }
    }
  } else {
    previsualizarSkuInv();
  }
}

// Elegir el SKU de un servicio propone su nombre si el campo está vacío.
invSku.addEventListener('input', () => {
  const s = invSkusServicios && invSkusServicios.find((x) => x.sku === invSku.value.trim().toUpperCase());
  const nombre = document.getElementById('inv-nombre');
  if (s && !nombre.value.trim()) nombre.value = s.nombre;
});
invSkuToggle.addEventListener('click', () => activarSkuManualInv(!invSkuManual));

function agregarFilaProveedor(proveedorId, skuProveedor) {
  const div = document.createElement('div');
  div.className = 'inv-prov-fila';
  div.innerHTML = `
    <select>${opcionesProveedor(proveedorId)}</select>
    <input type="text" placeholder="SKU del proveedor (opcional)" value="${esc(skuProveedor || '')}" />
    <button type="button" class="btn-delete-row" title="Quitar">✕</button>
  `;
  if (proveedorId) div.querySelector('select').value = proveedorId;
  div.querySelector('button').addEventListener('click', () => div.remove());
  invProvFilas.appendChild(div);
}

function abrirInvModal(p) {
  invEditando = p ? p.id : null;
  document.getElementById('inv-modal-title').textContent = p ? 'Editar producto' : 'Nuevo producto';
  invFormMessage.textContent = '';
  invFormMessage.className = 'message';

  // El SKU no cambia nunca: al editar solo se muestra.
  invSkuToggle.classList.toggle('hidden', !!p);
  invSkuManual = false;
  invSku.readOnly = true;
  invSkuToggle.textContent = 'Escribirlo o elegir el de un servicio';
  invSku.value = p ? p.sku : '';

  invCategoria.innerHTML = '<option value="">Sin categoría</option>' + opcionesRaices(p ? p.categoria_padre_id : null);
  invCategoria.value = p && p.categoria_padre_id ? p.categoria_padre_id : invFiltroCategoria.value || '';
  poblarFamiliasForm(p ? p.familia_id : null);
  document.getElementById('inv-nombre').value = p ? p.nombre : '';
  document.getElementById('inv-descripcion').value = p && p.descripcion ? p.descripcion : '';
  document.getElementById('inv-unidad-base').value = p ? p.unidad_base : '';
  document.getElementById('inv-unidad-compra').value = p ? p.unidad_compra : '';
  document.getElementById('inv-factor').value = p ? p.factor : '';
  document.getElementById('inv-minimo').value = p && p.stock_minimo !== null ? p.stock_minimo : '';

  invProvFilas.innerHTML = '';
  if (p) p.proveedores.forEach((s) => agregarFilaProveedor(s.proveedor_id, s.sku_proveedor));

  invModal.classList.remove('hidden');
  if (!p) previsualizarSkuInv();
  document.getElementById('inv-nombre').focus();
}

function opcionesRaices(seleccionado) {
  return invRaices()
    .filter((c) => c.activo || c.id === seleccionado)
    .map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`)
    .join('');
}

invCategoria.addEventListener('change', () => {
  poblarFamiliasForm(null);
  previsualizarSkuInv();
});
invFamilia.addEventListener('change', previsualizarSkuInv);
document.getElementById('inv-proveedor-agregar').addEventListener('click', () => agregarFilaProveedor(null, ''));
document.getElementById('inv-cancelar').addEventListener('click', () => invModal.classList.add('hidden'));
invModal.addEventListener('click', (e) => {
  if (e.target === invModal) invModal.classList.add('hidden');
});

invForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  invFormMessage.textContent = '';
  invFormMessage.className = 'message';
  invGuardar.disabled = true;

  const body = {
    sku: invSkuManual ? invSku.value.trim() : '',
    nombre: document.getElementById('inv-nombre').value.trim(),
    descripcion: document.getElementById('inv-descripcion').value.trim(),
    categoria_id: categoriaIdElegida(),
    unidad_base: document.getElementById('inv-unidad-base').value.trim(),
    unidad_compra: document.getElementById('inv-unidad-compra').value.trim(),
    factor: document.getElementById('inv-factor').value,
    stock_minimo: document.getElementById('inv-minimo').value,
    proveedores: [...invProvFilas.querySelectorAll('.inv-prov-fila')].map((f) => ({
      proveedor_id: f.querySelector('select').value,
      sku_proveedor: f.querySelector('input').value.trim(),
    })),
  };

  try {
    await invApi(invEditando !== null ? `/api/admin/inventario/${invEditando}` : '/api/admin/inventario', invEditando !== null ? 'PUT' : 'POST', body);
    invModal.classList.add('hidden');
    await cargarCatalogoInventario();
    await cargarInventario({ reset: true });
  } catch (err) {
    invFormMessage.textContent = err.message;
    invFormMessage.className = 'message error';
  } finally {
    invGuardar.disabled = false;
  }
});

// --- Categorías -------------------------------------------------------------

const invCatModal = document.getElementById('inv-cat-modal');
const invCatBody = document.getElementById('inv-cat-body');
const invCatMessage = document.getElementById('inv-cat-message');

function renderCategorias() {
  document.getElementById('inv-cat-padre').innerHTML =
    '<option value="">Categoría nueva</option>' +
    invRaices().filter((c) => c.activo).map((c) => `<option value="${c.id}">Familia de ${esc(c.nombre)}</option>`).join('');

  const fila = (c, hijo) => `
    <tr>
      <td class="${hijo ? 'cell-hijo' : ''}" data-nombre-cat="${c.id}">${esc(c.nombre)}</td>
      <td>${c.productos}</td>
      <td>${c.activo ? 'Activa' : 'Desactivada'}</td>
      <td>
        <button type="button" class="link-btn" data-renombrar-cat="${c.id}">Renombrar</button>
        <button type="button" class="link-btn" data-toggle-cat="${c.id}">${c.activo ? 'Desactivar' : 'Activar'}</button>
      </td>
    </tr>`;
  invCatBody.innerHTML = invRaices()
    .map((c) => fila(c, false) + invHijas(c.id).map((h) => fila(h, true)).join(''))
    .join('');
}

async function refrescarCategorias() {
  await cargarCatalogoInventario();
  renderCategorias();
}

document.getElementById('btn-inv-categorias').addEventListener('click', () => {
  invCatMessage.textContent = '';
  renderCategorias();
  invCatModal.classList.remove('hidden');
});
document.getElementById('inv-cat-cerrar').addEventListener('click', () => {
  invCatModal.classList.add('hidden');
  cargarInventario({ reset: true });
});

document.getElementById('inv-cat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  invCatMessage.textContent = '';
  try {
    await invApi('/api/admin/inventario/categorias', 'POST', {
      nombre: document.getElementById('inv-cat-nombre').value,
      parent_id: document.getElementById('inv-cat-padre').value,
    });
    document.getElementById('inv-cat-nombre').value = '';
    await refrescarCategorias();
  } catch (err) {
    invCatMessage.textContent = err.message;
    invCatMessage.className = 'message error';
  }
});

invCatBody.addEventListener('click', async (e) => {
  const renombrar = e.target.closest('[data-renombrar-cat]');
  const toggle = e.target.closest('[data-toggle-cat]');
  const guardar = e.target.closest('[data-guardar-cat]');
  try {
    if (renombrar) {
      // La celda del nombre pasa a ser un input editable.
      const celda = invCatBody.querySelector(`[data-nombre-cat="${renombrar.dataset.renombrarCat}"]`);
      celda.innerHTML = `<input type="text" value="${esc(celda.textContent)}" /> <button type="button" class="link-btn" data-guardar-cat="${renombrar.dataset.renombrarCat}">Guardar</button>`;
      celda.querySelector('input').focus();
    } else if (guardar) {
      const id = Number(guardar.dataset.guardarCat);
      const nombre = guardar.closest('td').querySelector('input').value;
      await invApi(`/api/admin/inventario/categorias/${id}`, 'PUT', { nombre });
      await refrescarCategorias();
    } else if (toggle) {
      const c = invCategorias.find((x) => x.id === Number(toggle.dataset.toggleCat));
      await invApi(`/api/admin/inventario/categorias/${c.id}`, 'PUT', { nombre: c.nombre, activo: !c.activo });
      await refrescarCategorias();
    }
  } catch (err) {
    invCatMessage.textContent = err.message;
    invCatMessage.className = 'message error';
  }
});

// --- Proveedores ------------------------------------------------------------

const invProvModal = document.getElementById('inv-prov-modal');
const invProvForm = document.getElementById('inv-prov-form');
const invProvBody = document.getElementById('inv-prov-body');
const invProvMessage = document.getElementById('inv-prov-message');
const CAMPOS_PROV = ['nombre', 'ruc', 'contacto', 'telefono', 'correo'];
let invProvEditando = null;

function renderProveedores() {
  invProvBody.innerHTML = invProveedores
    .map(
      (p) => `
    <tr>
      <td>${esc(p.nombre)}</td><td>${esc(p.ruc) || ''}</td><td>${esc(p.contacto) || ''}</td><td>${esc(p.telefono) || ''}</td>
      <td>${p.activo ? 'Activo' : 'Desactivado'}</td>
      <td>
        <button type="button" class="link-btn" data-editar-prov="${p.id}">Editar</button>
        <button type="button" class="link-btn" data-toggle-prov="${p.id}">${p.activo ? 'Desactivar' : 'Activar'}</button>
        <button type="button" class="link-btn" data-borrar-prov="${p.id}">Borrar</button>
      </td>
    </tr>`
    )
    .join('');
}

function editarProveedor(p) {
  invProvEditando = p ? p.id : null;
  CAMPOS_PROV.forEach((c) => {
    document.getElementById(`inv-prov-${c}`).value = p && p[c] ? p[c] : '';
  });
  document.getElementById('inv-prov-guardar').textContent = p ? 'Guardar cambios' : 'Agregar proveedor';
  document.getElementById('inv-prov-nuevo').classList.toggle('hidden', !p);
}

document.getElementById('btn-inv-proveedores').addEventListener('click', () => {
  invProvMessage.textContent = '';
  editarProveedor(null);
  renderProveedores();
  invProvModal.classList.remove('hidden');
});
document.getElementById('inv-prov-cerrar').addEventListener('click', () => {
  invProvModal.classList.add('hidden');
  cargarInventario({ reset: true });
});
document.getElementById('inv-prov-nuevo').addEventListener('click', () => editarProveedor(null));

invProvForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  invProvMessage.textContent = '';
  const body = Object.fromEntries(CAMPOS_PROV.map((c) => [c, document.getElementById(`inv-prov-${c}`).value]));
  try {
    if (invProvEditando !== null) {
      const actual = invProveedores.find((p) => p.id === invProvEditando);
      await invApi(`/api/admin/inventario/proveedores/${invProvEditando}`, 'PUT', { ...body, activo: actual.activo });
    } else {
      await invApi('/api/admin/inventario/proveedores', 'POST', body);
    }
    editarProveedor(null);
    await cargarCatalogoInventario();
    renderProveedores();
  } catch (err) {
    invProvMessage.textContent = err.message;
    invProvMessage.className = 'message error';
  }
});

invProvBody.addEventListener('click', async (e) => {
  const editar = e.target.closest('[data-editar-prov]');
  const toggle = e.target.closest('[data-toggle-prov]');
  const borrar = e.target.closest('[data-borrar-prov]');
  try {
    if (editar) {
      editarProveedor(invProveedores.find((p) => p.id === Number(editar.dataset.editarProv)));
    } else if (toggle) {
      const p = invProveedores.find((x) => x.id === Number(toggle.dataset.toggleProv));
      await invApi(`/api/admin/inventario/proveedores/${p.id}`, 'PUT', { ...p, activo: !p.activo });
    } else if (borrar) {
      const p = invProveedores.find((x) => x.id === Number(borrar.dataset.borrarProv));
      if (!(await mostrarConfirm(`¿Borrar el proveedor ${p.nombre}?`))) return;
      await invApi(`/api/admin/inventario/proveedores/${p.id}`, 'DELETE');
    } else {
      return;
    }
    await cargarCatalogoInventario();
    renderProveedores();
  } catch (err) {
    invProvMessage.textContent = err.message;
    invProvMessage.className = 'message error';
  }
});

// --- Conteo inicial ---------------------------------------------------------

const invConteoModal = document.getElementById('inv-conteo-modal');
const invConteoResultado = document.getElementById('inv-conteo-resultado');

document.getElementById('btn-inv-conteo').addEventListener('click', () => {
  invConteoResultado.innerHTML = '';
  document.getElementById('inv-conteo-archivo').value = '';
  invConteoModal.classList.remove('hidden');
});
document.getElementById('inv-conteo-cerrar').addEventListener('click', () => invConteoModal.classList.add('hidden'));

document.getElementById('inv-conteo-subir').addEventListener('click', async () => {
  const archivo = document.getElementById('inv-conteo-archivo').files[0];
  if (!archivo) {
    invConteoResultado.className = 'message error';
    invConteoResultado.textContent = 'Elegí el archivo .xlsx.';
    return;
  }
  const btn = document.getElementById('inv-conteo-subir');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/inventario/conteo-inicial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await archivo.arrayBuffer(),
    });
    const data = await res.json();
    if (!res.ok) {
      invConteoResultado.className = 'message error';
      invConteoResultado.innerHTML =
        esc(data.error) + (data.errores ? '<ul>' + data.errores.map((x) => `<li>Fila ${x.fila}: ${esc(x.error)}</li>`).join('') + '</ul>' : '');
      return;
    }
    invConteoResultado.className = 'message';
    invConteoResultado.textContent = `Listo: ${data.cargados} producto(s) cargados.`;
    cargarInventario({ reset: true });
  } catch (err) {
    invConteoResultado.className = 'message error';
    invConteoResultado.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// --- Cableado ---------------------------------------------------------------

function marcarColumnaOrdenadaInv() {
  invTabla.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('sort-asc', th.dataset.sort === invState.sort && invState.dir === 'asc');
    th.classList.toggle('sort-desc', th.dataset.sort === invState.sort && invState.dir === 'desc');
  });
}

function configurarInventario() {
  const recargar = debounce(() => cargarInventario({ reset: true }), 400);
  invQ.addEventListener('input', recargar);
  invFiltroCategoria.addEventListener('change', () => {
    refrescarFiltrosInventario();
    cargarInventario({ reset: true });
  });
  [invFiltroFamilia, invFiltroProveedor, invBajoMinimo, invNegativo, invDescontinuados].forEach((el) =>
    el.addEventListener('change', () => cargarInventario({ reset: true }))
  );

  invTabla.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (invState.sort === col) {
        invState.dir = invState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        invState.sort = col;
        invState.dir = 'asc';
      }
      marcarColumnaOrdenadaInv();
      cargarInventario({ reset: true });
    });
  });
  invScroll.addEventListener('scroll', () => {
    if (invScroll.scrollTop + invScroll.clientHeight >= invScroll.scrollHeight - 80) cargarInventario({ reset: false });
  });
  marcarColumnaOrdenadaInv();

  // Selección: marcar filas / marcar todas las cargadas / todas las del filtro.
  invBody.addEventListener('change', (e) => {
    const chk = e.target.closest('[data-sel]');
    if (!chk) return;
    invSel.todos = false;
    const id = Number(chk.dataset.sel);
    if (chk.checked) invSel.ids.add(id);
    else invSel.ids.delete(id);
    actualizarBarraBulk();
  });
  document.getElementById('inventario-check-todos').addEventListener('change', (e) => {
    invSel.todos = false;
    invBody.querySelectorAll('[data-sel]').forEach((chk) => {
      chk.checked = e.target.checked;
      const id = Number(chk.dataset.sel);
      if (e.target.checked) invSel.ids.add(id);
      else invSel.ids.delete(id);
    });
    actualizarBarraBulk();
  });
  document.getElementById('inventario-bulk-todos').addEventListener('click', () => {
    invSel.todos = true;
    invBody.querySelectorAll('[data-sel]').forEach((chk) => (chk.checked = true));
    actualizarBarraBulk();
  });
  document.getElementById('inventario-bulk-limpiar').addEventListener('click', () => {
    invBody.querySelectorAll('[data-sel]').forEach((chk) => (chk.checked = false));
    limpiarSeleccionInv();
  });
  document.getElementById('inventario-bulk-accion').addEventListener('change', actualizarValorBulk);
  document.getElementById('inventario-bulk-aplicar').addEventListener('click', aplicarBulk);
  actualizarValorBulk();

  document.getElementById('btn-nuevo-inventario').addEventListener('click', () => abrirInvModal(null));
  document.getElementById('btn-export-inventario').addEventListener('click', () => {
    window.location.href = `/api/admin/inventario/export?${invParams()}`;
  });

  invBody.addEventListener('click', async (e) => {
    const editar = e.target.closest('[data-edit-inv]');
    if (editar) return abrirInvModal(editar.closest('tr')._producto);

    const borrar = e.target.closest('[data-delete-inv]');
    if (!borrar) return;
    const fila = borrar.closest('tr');
    if (!(await mostrarConfirm(`¿Eliminar el producto ${fila._producto.sku} — ${fila._producto.nombre}?`))) return;
    try {
      await invApi(`/api/admin/inventario/${borrar.dataset.deleteInv}`, 'DELETE');
      fila.remove();
      invSel.ids.delete(fila._producto.id);
      invState.total -= 1;
      document.getElementById('inventario-stat-total').textContent = invState.total;
      actualizarBarraBulk();
    } catch (err) {
      await mostrarAlert(err.message);
    }
  });

  cargarCatalogoInventario().catch(() => {});
  cargarInventario({ reset: true });
}
