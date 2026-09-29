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
    <td>${p.ultima_compra ? esc(fmtFecha(p.ultima_compra)) : '—'}</td>
    <td>${proveedores || '—'}</td>
    <td>
      <div class="row-actions">
        <button type="button" class="btn-edit-row" data-usos-inv="${p.id}" title="Dónde se usa">⧉</button>
        <button type="button" class="btn-edit-row" data-ajuste-inv="${p.id}" title="Ajustar stock">±</button>
        <button type="button" class="btn-edit-row" data-hist-inv="${p.id}" title="Ver movimientos">☰</button>
        <button type="button" class="btn-edit-row" data-edit-inv="${p.id}" title="Editar producto">✎</button>
        ${p.discontinuado_at ? '' : `<button type="button" class="btn-edit-row" data-desc-inv="${p.id}" title="Descontinuar">⊘</button>`}
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
    proveedor: 'sumar el proveedor elegido a los proveedores',
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

// Sube un .xlsx como cuerpo binario y muestra el resultado (o la lista de
// errores por fila) en `resultado`. Devuelve true si se cargó.
async function subirExcel(url, archivoInput, resultado, boton, mensajeOk) {
  const archivo = archivoInput.files[0];
  if (!archivo) {
    resultado.className = 'message error';
    resultado.textContent = 'Elegí el archivo .xlsx.';
    return false;
  }
  boton.disabled = true;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await archivo.arrayBuffer() });
    const data = await res.json();
    if (!res.ok) {
      resultado.className = 'message error';
      resultado.innerHTML =
        esc(data.error) + (data.errores ? '<ul>' + data.errores.map((x) => `<li>Fila ${x.fila}: ${esc(x.error)}</li>`).join('') + '</ul>' : '');
      return false;
    }
    resultado.className = 'message';
    resultado.textContent = mensajeOk(data);
    return true;
  } catch (err) {
    resultado.className = 'message error';
    resultado.textContent = err.message;
    return false;
  } finally {
    boton.disabled = false;
  }
}

document.getElementById('inv-conteo-subir').addEventListener('click', async () => {
  const ok = await subirExcel(
    '/api/admin/inventario/conteo-inicial',
    document.getElementById('inv-conteo-archivo'),
    invConteoResultado,
    document.getElementById('inv-conteo-subir'),
    (d) => `Listo: ${d.cargados} producto(s) cargados.`
  );
  if (ok) cargarInventario({ reset: true });
});

// --- Compras ----------------------------------------------------------------

const invCompraModal = document.getElementById('inv-compra-modal');
const invCompraLineas = document.getElementById('inv-compra-lineas');
const invCompraMessage = document.getElementById('inv-compra-message');
let invOpciones = []; // productos activos, para las líneas
const invEtiqueta = (p) => `${p.sku} — ${p.nombre}`;

async function abrirCompra() {
  invCompraMessage.textContent = '';
  invCompraMessage.className = 'message';
  try {
    const [opc, hoy] = await Promise.all([invApi('/api/admin/inventario/opciones'), fetch('/api/admin/hoy').then((r) => r.json())]);
    invOpciones = opc.rows;
    document.getElementById('inv-compra-fecha').value = hoy.fecha;
  } catch (err) {
    return mostrarAlert(err.message);
  }
  document.getElementById('inv-compra-opciones').innerHTML = invOpciones.map((p) => `<option value="${esc(invEtiqueta(p))}"></option>`).join('');
  document.getElementById('inv-compra-proveedor').innerHTML = '<option value="">Elegí...</option>' + opcionesProveedor(null);
  document.getElementById('inv-compra-proveedor').value = '';
  document.getElementById('inv-compra-factura').value = '';
  invCompraLineas.innerHTML = '';
  agregarLineaCompra();
  actualizarTotalCompra();
  invCompraModal.classList.remove('hidden');
}

function productoDeLinea(linea) {
  return invOpciones.find((p) => invEtiqueta(p) === linea.querySelector('.lin-producto').value);
}

// Al elegir el producto se muestra la unidad de compra (y cuánto equivale en
// base) y se propone el SKU con el que este proveedor lo vende, si ya se sabe.
function refrescarLineaCompra(linea) {
  const p = productoDeLinea(linea);
  linea.querySelector('.lin-unidad').textContent = p ? `${p.unidad_compra} (= ${fmtCantidad(p.factor)} ${p.unidad_base})` : '';
  const skuInput = linea.querySelector('.lin-sku');
  const prov = Number(document.getElementById('inv-compra-proveedor').value);
  if (p && !skuInput.value) {
    const s = p.proveedores.find((x) => x.proveedor_id === prov && x.sku_proveedor);
    if (s) skuInput.value = s.sku_proveedor;
  }
  const cant = Number(linea.querySelector('.lin-cantidad').value) || 0;
  const costo = Number(linea.querySelector('.lin-costo').value) || 0;
  linea.querySelector('.lin-subtotal').textContent = fmtMoneda(Math.round(cant * costo * 100) / 100);
  actualizarTotalCompra();
}

function actualizarTotalCompra() {
  const total = [...invCompraLineas.querySelectorAll('.inv-prov-fila')].reduce((acc, l) => {
    const cant = Number(l.querySelector('.lin-cantidad').value) || 0;
    const costo = Number(l.querySelector('.lin-costo').value) || 0;
    return acc + Math.round(cant * costo * 100) / 100;
  }, 0);
  document.getElementById('inv-compra-total').textContent = fmtMoneda(total);
}

function agregarLineaCompra() {
  const div = document.createElement('div');
  div.className = 'inv-prov-fila';
  div.innerHTML = `
    <input type="text" class="lin-producto" list="inv-compra-opciones" placeholder="SKU o nombre del producto" style="flex: 3" />
    <input type="number" class="lin-cantidad" min="0" step="any" placeholder="Cant." />
    <input type="number" class="lin-costo" min="0" step="any" placeholder="Costo unit." />
    <input type="text" class="lin-sku" placeholder="SKU prov." />
    <span class="lin-unidad table-status"></span>
    <span class="lin-subtotal cell-precio">S/ 0.00</span>
    <button type="button" class="btn-delete-row" title="Quitar">✕</button>
  `;
  div.addEventListener('input', () => refrescarLineaCompra(div));
  div.querySelector('button').addEventListener('click', () => {
    div.remove();
    actualizarTotalCompra();
  });
  invCompraLineas.appendChild(div);
}

document.getElementById('inv-compra-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  invCompraMessage.textContent = '';
  invCompraMessage.className = 'message';
  const items = [];
  for (const l of invCompraLineas.querySelectorAll('.inv-prov-fila')) {
    const p = productoDeLinea(l);
    if (!p && !l.querySelector('.lin-producto').value) continue; // línea vacía
    if (!p) {
      invCompraMessage.textContent = 'Elegí cada producto de la lista de sugerencias.';
      invCompraMessage.className = 'message error';
      return;
    }
    items.push({
      producto_id: p.id,
      cantidad: l.querySelector('.lin-cantidad').value,
      costo_unitario: l.querySelector('.lin-costo').value,
      sku_proveedor: l.querySelector('.lin-sku').value.trim(),
    });
  }
  const btn = document.getElementById('inv-compra-guardar');
  btn.disabled = true;
  try {
    await invApi('/api/admin/inventario/compras', 'POST', {
      proveedor_id: document.getElementById('inv-compra-proveedor').value,
      nro_factura: document.getElementById('inv-compra-factura').value,
      fecha: document.getElementById('inv-compra-fecha').value,
      items,
    });
    invCompraModal.classList.add('hidden');
    await cargarInventario({ reset: true });
  } catch (err) {
    invCompraMessage.textContent = err.message;
    invCompraMessage.className = 'message error';
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('inv-compra-agregar').addEventListener('click', agregarLineaCompra);
document.getElementById('inv-compra-cancelar').addEventListener('click', () => invCompraModal.classList.add('hidden'));

// Lista de compras y detalle con anulación.
const invComprasModal = document.getElementById('inv-compras-modal');
const invComprasBody = document.getElementById('inv-compras-body');
const invComprasState = { offset: 0 };

async function cargarCompras({ reset }) {
  if (reset) {
    invComprasState.offset = 0;
    invComprasBody.innerHTML = '';
  }
  const data = await invApi(`/api/admin/inventario/compras?offset=${invComprasState.offset}`);
  invComprasState.offset += data.rows.length;
  invComprasBody.insertAdjacentHTML(
    'beforeend',
    data.rows
      .map(
        (c) => `
    <tr${c.anulada_at ? ' class="descontinuado"' : ''}>
      <td>${esc(fmtFecha(c.fecha))}</td><td>${esc(c.proveedor)}</td><td>${esc(c.nro_factura) || '—'}</td>
      <td class="cell-precio">${fmtMoneda(c.total)}</td>
      <td>${c.anulada_at ? '<span class="pill">Anulada</span>' : 'Vigente'}</td>
      <td><button type="button" class="link-btn" data-ver-compra="${c.id}">Ver</button></td>
    </tr>`
      )
      .join('')
  );
  document.getElementById('inv-compras-mas').classList.toggle('hidden', !data.hasMore);
}

document.getElementById('btn-inv-compras').addEventListener('click', async () => {
  invComprasModal.classList.remove('hidden');
  try {
    await cargarCompras({ reset: true });
  } catch (err) {
    await mostrarAlert(err.message);
  }
});
document.getElementById('inv-compras-mas').addEventListener('click', () => cargarCompras({ reset: false }));
document.getElementById('inv-compras-cerrar').addEventListener('click', () => invComprasModal.classList.add('hidden'));

const invCompraDet = document.getElementById('inv-compra-det-modal');
let invCompraViendo = null;

async function verCompra(id) {
  try {
    const { compra } = await invApi(`/api/admin/inventario/compras/${id}`);
    invCompraViendo = compra;
    document.getElementById('inv-compra-det-titulo').textContent = `Compra #${compra.id}${compra.anulada_at ? ' (anulada)' : ''}`;
    document.getElementById('inv-compra-det-info').textContent =
      `${compra.proveedor} · factura ${compra.nro_factura || 's/n'} · ${fmtFecha(compra.fecha)} · total ${fmtMoneda(compra.total)}` +
      (compra.usuario ? ` · cargada por ${compra.usuario}` : '');
    document.getElementById('inv-compra-det-body').innerHTML = compra.items
      .map(
        (i) => `<tr><td class="cell-sku">${esc(i.sku)}</td><td>${esc(i.nombre)}</td><td>${esc(i.sku_proveedor) || ''}</td>
          <td class="cell-precio">${fmtCantidad(i.cantidad)} ${esc(i.unidad_compra)}</td>
          <td class="cell-precio">${fmtMoneda(i.costo_unitario)}</td><td class="cell-precio">${fmtMoneda(i.subtotal)}</td></tr>`
      )
      .join('');
    document.getElementById('inv-compra-det-message').textContent = '';
    document.getElementById('inv-compra-det-anular').classList.toggle('hidden', !!compra.anulada_at);
    invCompraDet.classList.remove('hidden');
  } catch (err) {
    await mostrarAlert(err.message);
  }
}

invComprasBody.addEventListener('click', (e) => {
  const ver = e.target.closest('[data-ver-compra]');
  if (ver) verCompra(ver.dataset.verCompra);
});
document.getElementById('inv-compra-det-cerrar').addEventListener('click', () => invCompraDet.classList.add('hidden'));
document.getElementById('inv-compra-det-anular').addEventListener('click', async () => {
  if (!(await mostrarConfirm(`¿Anular la compra #${invCompraViendo.id}? El stock vuelve a lo de antes y se recalcula el costo promedio.`))) return;
  try {
    await invApi(`/api/admin/inventario/compras/${invCompraViendo.id}/anular`, 'POST', {});
    invCompraDet.classList.add('hidden');
    await cargarCompras({ reset: true });
    await cargarInventario({ reset: true });
  } catch (err) {
    const msg = document.getElementById('inv-compra-det-message');
    msg.textContent = err.message;
    msg.className = 'message error';
  }
});

// --- Ajuste de stock e historial -------------------------------------------

const invAjusteModal = document.getElementById('inv-ajuste-modal');
const invAjusteMessage = document.getElementById('inv-ajuste-message');
let invAjustando = null;

function abrirAjuste(p) {
  invAjustando = p;
  document.getElementById('inv-ajuste-titulo').textContent = `Ajustar stock — ${p.sku}`;
  document.getElementById('inv-ajuste-info').textContent = `${p.nombre}. Stock actual: ${fmtCantidad(p.stock)} ${p.unidad_base}. No puede quedar en negativo.`;
  document.getElementById('inv-ajuste-cantidad').value = '';
  document.getElementById('inv-ajuste-motivo').value = '';
  invAjusteMessage.textContent = '';
  invAjusteModal.classList.remove('hidden');
  document.getElementById('inv-ajuste-cantidad').focus();
}

document.getElementById('inv-ajuste-cancelar').addEventListener('click', () => invAjusteModal.classList.add('hidden'));
document.getElementById('inv-ajuste-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  invAjusteMessage.textContent = '';
  invAjusteMessage.className = 'message';
  try {
    await invApi(`/api/admin/inventario/${invAjustando.id}/ajuste`, 'POST', {
      cantidad: document.getElementById('inv-ajuste-cantidad').value,
      motivo: document.getElementById('inv-ajuste-motivo').value,
    });
    invAjusteModal.classList.add('hidden');
    await cargarInventario({ reset: true });
  } catch (err) {
    invAjusteMessage.textContent = err.message;
    invAjusteMessage.className = 'message error';
  }
});

const invHistModal = document.getElementById('inv-hist-modal');
const invHistBody = document.getElementById('inv-hist-body');
const invHistState = { producto: null, offset: 0 };
const TIPO_MOV_LABEL = { conteo_inicial: 'Conteo inicial', compra: 'Compra', consumo: 'Consumo', ajuste: 'Ajuste', anulacion: 'Anulación' };

async function cargarHistorial({ reset }) {
  if (reset) {
    invHistState.offset = 0;
    invHistBody.innerHTML = '';
  }
  const data = await invApi(`/api/admin/inventario/${invHistState.producto.id}/movimientos?offset=${invHistState.offset}`);
  invHistState.offset += data.rows.length;
  invHistBody.insertAdjacentHTML(
    'beforeend',
    data.rows
      .map((m) => {
        const ref = m.ref_tipo ? ` (${esc(m.ref_tipo)} #${m.ref_id})` : '';
        return `<tr><td>${esc(fmtFechaHora(m.created_at))}</td><td>${TIPO_MOV_LABEL[m.tipo] || esc(m.tipo)}</td>
          <td class="cell-precio${m.cantidad < 0 ? ' stock-negativo' : ''}">${m.cantidad > 0 ? '+' : ''}${fmtCantidad(m.cantidad)}</td>
          <td class="cell-precio">${m.costo_unitario === null ? '—' : fmtCosto(m.costo_unitario)}</td>
          <td>${esc(m.motivo) || ''}${ref}</td><td>${esc(m.usuario) || ''}</td></tr>`;
      })
      .join('')
  );
  document.getElementById('inv-hist-mas').classList.toggle('hidden', !data.hasMore);
}

async function abrirHistorial(p) {
  invHistState.producto = p;
  document.getElementById('inv-hist-titulo').textContent = `Movimientos — ${p.sku} ${p.nombre} (en ${p.unidad_base})`;
  invHistModal.classList.remove('hidden');
  try {
    await cargarHistorial({ reset: true });
  } catch (err) {
    await mostrarAlert(err.message);
  }
}
document.getElementById('inv-hist-mas').addEventListener('click', () => cargarHistorial({ reset: false }));
document.getElementById('inv-hist-cerrar').addEventListener('click', () => invHistModal.classList.add('hidden'));

// --- Guía de consumo (dentro del formulario de servicio) --------------------

const guiaFilas = document.getElementById('guia-filas');
let guiaOpciones = [];

function agregarFilaGuia(productoId, cantidad) {
  const p = guiaOpciones.find((x) => x.id === productoId);
  const div = document.createElement('div');
  div.className = 'inv-prov-fila';
  div.innerHTML = `
    <input type="text" class="guia-producto" list="guia-opciones" placeholder="SKU o nombre del insumo" style="flex: 3" value="${p ? esc(invEtiqueta(p)) : ''}" />
    <input type="number" class="guia-cantidad" min="0" step="any" placeholder="Cantidad" value="${cantidad ?? ''}" />
    <span class="lin-unidad table-status"></span>
    <button type="button" class="btn-delete-row" title="Quitar">✕</button>
  `;
  const unidad = () => {
    const sel = guiaOpciones.find((x) => invEtiqueta(x) === div.querySelector('.guia-producto').value);
    div.querySelector('.lin-unidad').textContent = sel ? sel.unidad_base : '';
  };
  div.querySelector('.guia-producto').addEventListener('input', unidad);
  div.querySelector('button').addEventListener('click', () => div.remove());
  guiaFilas.appendChild(div);
  unidad();
}

// Se llama al abrir el formulario de servicio (solo con permiso de inventario).
async function abrirGuiaInsumos(servicioSku) {
  const seccion = document.getElementById('servicio-guia');
  seccion.classList.remove('hidden');
  guiaFilas.innerHTML = '';
  try {
    const [opc, guia] = await Promise.all([
      invApi('/api/admin/inventario/opciones'),
      servicioSku ? invApi(`/api/admin/servicios/${encodeURIComponent(servicioSku)}/insumos`) : { rows: [] },
    ]);
    guiaOpciones = opc.rows;
    document.getElementById('guia-opciones').innerHTML = guiaOpciones.map((p) => `<option value="${esc(invEtiqueta(p))}"></option>`).join('');
    guia.rows.forEach((r) => {
      // Un insumo ya descontinuado sigue en la guía: se agrega a las opciones para mostrarlo.
      if (!guiaOpciones.some((p) => p.id === r.producto_id)) {
        guiaOpciones.push({ id: r.producto_id, sku: r.sku, nombre: r.nombre, unidad_base: r.unidad_base });
      }
      agregarFilaGuia(r.producto_id, r.cantidad);
    });
  } catch (err) {
    seccion.classList.add('hidden'); // el servicio sigue siendo editable sin la guía
  }
}

// Reemplaza la guía del servicio por lo que hay en el formulario. Lanza si
// falla (el servicio ya está guardado: el mensaje lo aclara).
async function guardarGuiaInsumos(servicioSku) {
  if (document.getElementById('servicio-guia').classList.contains('hidden')) return;
  const items = [];
  for (const f of guiaFilas.querySelectorAll('.inv-prov-fila')) {
    const texto = f.querySelector('.guia-producto').value;
    const p = guiaOpciones.find((x) => invEtiqueta(x) === texto);
    if (!p && !texto) continue;
    if (!p) throw new Error('Servicio guardado, pero falta elegir cada insumo de la lista de sugerencias.');
    items.push({ producto_id: p.id, cantidad: f.querySelector('.guia-cantidad').value });
  }
  try {
    await invApi(`/api/admin/servicios/${encodeURIComponent(servicioSku)}/insumos`, 'PUT', { items });
  } catch (err) {
    throw new Error(`Servicio guardado, pero la guía de consumo falló: ${err.message}`);
  }
}

document.getElementById('guia-agregar').addEventListener('click', () => agregarFilaGuia(null, ''));

// Excel de guías (botón en la pestaña Servicios).
const invGuiaModal = document.getElementById('inv-guia-modal');
document.getElementById('btn-guia-excel').addEventListener('click', () => {
  document.getElementById('inv-guia-resultado').textContent = '';
  document.getElementById('inv-guia-archivo').value = '';
  invGuiaModal.classList.remove('hidden');
});
document.getElementById('inv-guia-cerrar').addEventListener('click', () => invGuiaModal.classList.add('hidden'));
document.getElementById('inv-guia-subir').addEventListener('click', () =>
  subirExcel(
    '/api/admin/inventario/guias-consumo',
    document.getElementById('inv-guia-archivo'),
    document.getElementById('inv-guia-resultado'),
    document.getElementById('inv-guia-subir'),
    (d) => `Listo: ${d.filas} fila(s) en ${d.servicios} servicio(s).`
  )
);

// --- Dónde se usa y descontinuar --------------------------------------------

async function abrirUsos(p) {
  document.getElementById('inv-usos-titulo').textContent = `Dónde se usa — ${p.sku} ${p.nombre}`;
  const body = document.getElementById('inv-usos-body');
  body.innerHTML = '';
  document.getElementById('inv-usos-modal').classList.remove('hidden');
  try {
    const { rows } = await invApi(`/api/admin/inventario/${p.id}/donde-se-usa`);
    body.innerHTML = rows.length
      ? rows
          .map((r) => `<tr><td class="cell-sku">${esc(r.servicio_sku)}</td><td>${esc(r.nombre)}</td><td class="cell-precio">${fmtCantidad(r.cantidad)} ${esc(p.unidad_base)}</td></tr>`)
          .join('')
      : '<tr><td colspan="3" class="table-status">Ningún servicio usa este producto.</td></tr>';
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3" class="message error">${esc(err.message)}</td></tr>`;
  }
}
document.getElementById('inv-usos-cerrar').addEventListener('click', () => document.getElementById('inv-usos-modal').classList.add('hidden'));

const invDescModal = document.getElementById('inv-desc-modal');
let invDescontinuando = null;

async function abrirDescontinuar(p) {
  invDescontinuando = p;
  document.getElementById('inv-desc-titulo').textContent = `Descontinuar — ${p.sku}`;
  document.getElementById('inv-desc-message').textContent = '';
  document.getElementById('inv-desc-cambiar').checked = false;
  let usos = [];
  let opciones = [];
  try {
    [usos, opciones] = await Promise.all([
      invApi(`/api/admin/inventario/${p.id}/donde-se-usa`).then((d) => d.rows),
      invApi('/api/admin/inventario/opciones').then((d) => d.rows),
    ]);
  } catch (err) {
    return mostrarAlert(err.message);
  }
  document.getElementById('inv-desc-info').textContent =
    `${p.nombre}. Deja de ofrecerse en las compras y se oculta de la lista (con "Mostrar descontinuados" sigue visible). ` +
    (usos.length ? `Lo usan ${usos.length} servicio(s).` : 'Ningún servicio lo usa.');
  document.getElementById('inv-desc-reemplazo').innerHTML =
    '<option value="">Sin reemplazo</option>' + opciones.filter((o) => o.id !== p.id).map((o) => `<option value="${o.id}">${esc(invEtiqueta(o))}</option>`).join('');
  document.getElementById('inv-desc-cambiar-wrap').classList.toggle('hidden', usos.length === 0);
  document.getElementById('inv-desc-cambiar-texto').textContent = `Poner el reemplazo en las ${usos.length} guía(s) de consumo que lo usan`;
  invDescModal.classList.remove('hidden');
}

document.getElementById('inv-desc-cancelar').addEventListener('click', () => invDescModal.classList.add('hidden'));
document.getElementById('inv-desc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await invApi(`/api/admin/inventario/${invDescontinuando.id}/descontinuar`, 'POST', {
      reemplazado_por: document.getElementById('inv-desc-reemplazo').value,
      cambiar_insumos: document.getElementById('inv-desc-cambiar').checked,
    });
    invDescModal.classList.add('hidden');
    await cargarInventario({ reset: true });
  } catch (err) {
    const msg = document.getElementById('inv-desc-message');
    msg.textContent = err.message;
    msg.className = 'message error';
  }
});

// --- Reposición -------------------------------------------------------------

async function abrirReposicion() {
  const cont = document.getElementById('inv-repo-contenido');
  cont.textContent = 'Cargando...';
  document.getElementById('inv-repo-modal').classList.remove('hidden');
  try {
    const { grupos } = await invApi('/api/admin/inventario/reposicion');
    cont.innerHTML = grupos.length
      ? grupos
          .map(
            (g) => `
      <div class="bloque-titulo" style="margin-top: 12px">${esc(g.proveedor)}</div>
      <table>
        <thead><tr><th>SKU</th><th>Producto</th><th>SKU prov.</th><th class="col-precio">Stock</th><th class="col-precio">Mínimo</th><th class="col-precio">Sugerido</th></tr></thead>
        <tbody>${g.items
          .map(
            (i) => `<tr><td class="cell-sku">${esc(i.sku)}</td><td>${esc(i.nombre)}</td><td>${esc(i.sku_proveedor) || ''}</td>
            <td class="cell-precio${i.stock < 0 ? ' stock-negativo' : ''}">${fmtCantidad(i.stock)} ${esc(i.unidad_base)}</td>
            <td class="cell-precio">${fmtCantidad(i.stock_minimo)}</td>
            <td class="cell-precio"><b>${fmtCantidad(i.sugerido)}</b> ${esc(i.unidad_compra)}</td></tr>`
          )
          .join('')}</tbody>
      </table>`
          )
          .join('')
      : '<p class="table-status">Nada por reponer.</p>';
  } catch (err) {
    cont.textContent = err.message;
  }
}
document.getElementById('btn-inv-reposicion').addEventListener('click', abrirReposicion);
document.getElementById('inv-repo-cerrar').addEventListener('click', () => document.getElementById('inv-repo-modal').classList.add('hidden'));
document.getElementById('inv-repo-export').addEventListener('click', () => {
  window.location.href = '/api/admin/inventario/reposicion/export';
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

  document.getElementById('btn-inv-compra').addEventListener('click', abrirCompra);
  document.getElementById('btn-guia-excel').classList.remove('hidden');
  document.getElementById('btn-nuevo-inventario').addEventListener('click', () => abrirInvModal(null));
  document.getElementById('btn-export-inventario').addEventListener('click', () => {
    window.location.href = `/api/admin/inventario/export?${invParams()}`;
  });

  invBody.addEventListener('click', async (e) => {
    const editar = e.target.closest('[data-edit-inv]');
    if (editar) return abrirInvModal(editar.closest('tr')._producto);
    const usos = e.target.closest('[data-usos-inv]');
    if (usos) return abrirUsos(usos.closest('tr')._producto);
    const desc = e.target.closest('[data-desc-inv]');
    if (desc) return abrirDescontinuar(desc.closest('tr')._producto);
    const ajuste = e.target.closest('[data-ajuste-inv]');
    if (ajuste) return abrirAjuste(ajuste.closest('tr')._producto);
    const hist = e.target.closest('[data-hist-inv]');
    if (hist) return abrirHistorial(hist.closest('tr')._producto);

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
