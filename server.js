require('dotenv').config();
const path = require('path');
const express = require('express');
const clientesRepo = require('./lib/clientesRepo');
const asistenciasRepo = require('./lib/asistenciasRepo');
const adminRepo = require('./lib/adminRepo');
const serviciosRepo = require('./lib/serviciosRepo');
const inventarioRepo = require('./lib/inventarioRepo');
const proveedoresRepo = require('./lib/proveedoresRepo');
const comprasRepo = require('./lib/comprasRepo');
const cotizacionesRepo = require('./lib/cotizacionesRepo');
const { generarCotizacionPdf, nombreArchivo } = require('./lib/cotizacionPdf');
const mailer = require('./lib/mailer');
const auth = require('./lib/auth');
const usuariosRepo = require('./lib/usuariosRepo');
const { toCsv } = require('./lib/csv');
const distritos = require('./lib/distritos.json');
const { resolveRange } = require('./lib/dateRanges');
const { peruNow } = require('./lib/peruTime');
const { validarFormatoDocumento } = require('./public/documentoValidation');

const app = express();
const PORT = process.env.PORT || 3000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISTRITOS = Object.keys(distritos);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/distritos -> ["Lima", "Ancon", ...] — el nombre (key) es el valor que se guarda.
app.get('/api/distritos', (req, res) => {
  res.json(DISTRITOS);
});

// GET /api/lookup/:documento -> { found: true, cliente: {...} } | { found: false }
app.get('/api/lookup/:documento', async (req, res) => {
  const documento = String(req.params.documento).trim();
  try {
    const cliente = await clientesRepo.lookupByDocumento(documento);
    res.json(cliente ? { found: true, cliente } : { found: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/asistencias-hoy/:documento -> { areas: ["Pilates", ...] } — áreas
// ya asistidas hoy (hora Perú) por este documento, para deshabilitarlas en
// el selector de servicios.
app.get('/api/asistencias-hoy/:documento', async (req, res) => {
  try {
    const areas = await asistenciasRepo.getAreasHoy(req.params.documento);
    res.json({ areas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clientes -> crea o actualiza (por DOCUMENTO)
app.post('/api/clientes', async (req, res) => {
  const input = req.body || {};

  if (!input.DOCUMENTO || !String(input.DOCUMENTO).trim()) {
    return res.status(400).json({ error: 'DOCUMENTO es requerido' });
  }
  if (!input.PACIENTE || !String(input.PACIENTE).trim()) {
    return res.status(400).json({ error: 'PACIENTE es requerido' });
  }
  if (!validarFormatoDocumento(input.TIPO_DOC, input.DOCUMENTO)) {
    return res.status(400).json({ error: `DOCUMENTO no tiene un formato válido para ${input.TIPO_DOC}` });
  }
  if (input.CORREO && !EMAIL_RE.test(String(input.CORREO).trim())) {
    return res.status(400).json({ error: 'CORREO no es un email válido' });
  }
  if (input.DISTRITO && !DISTRITOS.includes(input.DISTRITO)) {
    return res.status(400).json({ error: 'DISTRITO no es válido' });
  }

  try {
    const cliente = await clientesRepo.saveCliente(input);
    res.json({ ok: true, cliente });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/asistencias -> registra una asistencia (fecha/hora/turno automáticos, tipo_doc/paciente desde la BD)
app.post('/api/asistencias', async (req, res) => {
  const { NRO_DOC, AREA, SERVICIO } = req.body || {};

  if (!NRO_DOC || !String(NRO_DOC).trim()) {
    return res.status(400).json({ error: 'NRO_DOC es requerido' });
  }

  try {
    const asistencia = await asistenciasRepo.createAsistencia({
      nroDocumento: String(NRO_DOC).trim(),
      area: AREA,
      servicio: SERVICIO,
    });
    res.json({ ok: true, asistencia });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const user = await usuariosRepo.getUsuarioPorUsername(String(username || '').trim());
    if (!user || !user.activo || !auth.verifyPassword(String(password || ''), user.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    auth.setSessionCookie(req, res, user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/admin/session', async (req, res) => {
  try {
    const user = await auth.loadUser(req);
    if (!user) return res.json({ authenticated: false });
    res.json({
      authenticated: true,
      usuario: {
        username: user.username,
        rol: user.rol_nombre,
        esAdmin: user.es_admin,
        permisos: user.permisos,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/hoy -> { fecha: "YYYY-MM-DD" } — hoy en Perú, para que el
// front pueda prefijar filtros de fecha sin depender del timezone local.
app.get('/api/admin/hoy', auth.requireAuth, (req, res) => {
  res.json({ fecha: peruNow().fecha });
});

app.get('/api/admin/dashboard', auth.requireAuth, async (req, res) => {
  try {
    const { preset, desde, hasta } = req.query;
    const rango = resolveRange(preset || 'hoy', desde, hasta);
    const data = await adminRepo.getDashboard(rango);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseListParams(req) {
  const { distrito, area, servicio, desde, hasta, q, documento, offset } = req.query;
  return {
    distrito: distrito || null,
    area: area || null,
    servicio: servicio || null,
    desde: desde || null,
    hasta: hasta || null,
    q: q || null,
    documento: documento || null,
    offset: Number(offset) || 0,
    limit: 100,
  };
}

app.get('/api/admin/clientes', auth.requirePermission('clientes'), async (req, res) => {
  try {
    const data = await adminRepo.listClientes(parseListParams(req));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/clientes/export', auth.requirePermission('clientes'), async (req, res) => {
  try {
    const { distrito, area, servicio, desde, hasta, q } = req.query;
    const rows = await adminRepo.listClientesAll({
      distrito: distrito || null,
      area: area || null,
      servicio: servicio || null,
      desde: desde || null,
      hasta: hasta || null,
      q: q || null,
    });
    const csv = toCsv(rows, [
      { key: 'documento', label: 'Documento' },
      { key: 'tipo_doc', label: 'Tipo de documento' },
      { key: 'paciente', label: 'Paciente' },
      { key: 'apodo', label: 'Nombre preferido' },
      { key: 'celular', label: 'Celular' },
      { key: 'distrito', label: 'Distrito' },
      { key: 'f_nacimiento', label: 'Fecha de nacimiento' },
      { key: 'edad', label: 'Edad' },
      { key: 'sexo', label: 'Sexo' },
      { key: 'correo', label: 'Correo' },
      { key: 'direccion', label: 'Dirección' },
      { key: 'fecha_creacion', label: 'Fecha de registro' },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/asistencias', auth.requirePermission('asistencias'), async (req, res) => {
  try {
    const data = await adminRepo.listAsistencias(parseListParams(req));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/asistencias/resumen', auth.requirePermission('asistencias'), async (req, res) => {
  try {
    const params = parseListParams(req);
    const data = await adminRepo.getResumenAsistencias(params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Cuentas y roles del panel admin
// ---------------------------------------------------------------------------

app.get('/api/admin/roles', auth.requirePermission('cuentas'), async (req, res) => {
  try {
    res.json({ rows: await usuariosRepo.listRoles() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/roles', auth.requirePermission('cuentas'), async (req, res) => {
  try {
    const { nombre, permisos } = req.body || {};
    res.json({ ok: true, rol: await usuariosRepo.createRol({ nombre, permisos }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/roles/:id', auth.requirePermission('cuentas'), async (req, res) => {
  try {
    const { nombre, permisos } = req.body || {};
    const rol = await usuariosRepo.updateRol(req.params.id, { nombre, permisos });
    if (!rol) return res.status(404).json({ error: 'Rol no encontrado' });
    res.json({ ok: true, rol });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/roles/:id', auth.requirePermission('cuentas'), async (req, res) => {
  try {
    const ok = await usuariosRepo.deleteRol(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Rol no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/cuentas', auth.requirePermission('cuentas'), async (req, res) => {
  try {
    res.json({ rows: await usuariosRepo.listUsuarios() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/cuentas', auth.requirePermission('cuentas'), async (req, res) => {
  try {
    const { username, password, rolId } = req.body || {};
    if (!password || String(password).length < 4) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    }
    const usuario = await usuariosRepo.createUsuario({
      username,
      passwordHash: auth.hashPassword(String(password)),
      rolId,
    });
    res.json({ ok: true, usuario });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ese usuario ya existe' });
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/cuentas/:id', auth.requirePermission('cuentas'), async (req, res) => {
  try {
    const { rolId, activo, password } = req.body || {};
    if (Number(req.params.id) === req.user.id && activo === false) {
      return res.status(400).json({ error: 'No podés desactivar tu propia cuenta' });
    }
    if (password !== undefined && password !== '' && String(password).length < 4) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    }
    const usuario = await usuariosRepo.updateUsuario(req.params.id, {
      rolId,
      activo,
      passwordHash: password ? auth.hashPassword(String(password)) : undefined,
    });
    if (!usuario) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ ok: true, usuario });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/cuentas/:id', auth.requirePermission('cuentas'), async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'No podés borrar tu propia cuenta' });
    }
    const ok = await usuariosRepo.deleteUsuario(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Servicios (tarifario)
// ---------------------------------------------------------------------------

function parseServiciosParams(req) {
  const { q, categoria, familia, sort, dir, offset } = req.query;
  return {
    q: q || null,
    categoria: categoria || null,
    familia: familia || null,
    sort: sort || null,
    dir: dir || null,
    offset: Number(offset) || 0,
    limit: 100,
  };
}

app.get('/api/admin/servicios', auth.requirePermission('servicios'), async (req, res) => {
  try {
    const data = await serviciosRepo.listServicios(parseServiciosParams(req));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Categorías y familias existentes, para los filtros y el formulario.
app.get('/api/admin/servicios/facetas', auth.requirePermission('servicios'), async (req, res) => {
  try {
    res.json(await serviciosRepo.getFacetas());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listado liviano de servicios, para elegir el "servicio padre".
app.get('/api/admin/servicios/opciones', auth.requirePermission('servicios'), async (req, res) => {
  try {
    res.json({ rows: await serviciosRepo.listOpciones() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Próximo SKU disponible, para previsualizarlo en el formulario. El SKU
// definitivo igual se genera al guardar (acá puede quedar obsoleto si otro
// admin crea un servicio en el medio).
app.get('/api/admin/servicios/next-sku', auth.requirePermission('servicios'), async (req, res) => {
  try {
    const { categoria, familia, padre } = req.query;
    const sku = await serviciosRepo.nextSku({
      categoria: categoria || null,
      familia: familia || null,
      padre: padre || null,
    });
    res.json({ sku });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/servicios/export', auth.requirePermission('servicios'), async (req, res) => {
  try {
    const { q, categoria, familia, sort, dir } = req.query;
    const rows = await serviciosRepo.listServiciosAll({
      q: q || null,
      categoria: categoria || null,
      familia: familia || null,
      sort: sort || null,
      dir: dir || null,
    });
    const csv = toCsv(rows, [
      { key: 'sku', label: 'SKU' },
      { key: 'categoria', label: 'Categoría' },
      { key: 'familia', label: 'Familia' },
      { key: 'nombre', label: 'Servicio' },
      { key: 'precio_regular', label: 'Precio regular' },
      { key: 'precio_oferta', label: 'Precio oferta' },
      { key: 'precio_max_desc', label: 'Precio máximo descuento' },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="servicios.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/servicios', auth.requirePermission('servicios'), async (req, res) => {
  try {
    const servicio = await serviciosRepo.createServicio(req.body || {});
    res.json({ ok: true, servicio });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/servicios/:sku', auth.requirePermission('servicios'), async (req, res) => {
  try {
    const servicio = await serviciosRepo.updateServicio(req.params.sku, req.body || {});
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json({ ok: true, servicio });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/servicios/:sku', auth.requirePermission('servicios'), async (req, res) => {
  try {
    const ok = await serviciosRepo.deleteServicio(req.params.sku);
    if (!ok) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Inventario (un único permiso `inventario`: incluye ver y editar costos)
// ---------------------------------------------------------------------------

const permisoInventario = auth.requirePermission('inventario');

function parseInventarioFiltro(q) {
  return {
    q: q.q || null,
    categoria_id: q.categoria_id || null,
    familia_id: q.familia_id || null,
    proveedor_id: q.proveedor_id || null,
    bajo_minimo: q.bajo_minimo === '1',
    stock_negativo: q.stock_negativo === '1',
    descontinuados: q.descontinuados === '1',
    sort: q.sort || null,
    dir: q.dir || null,
  };
}

// Envuelve un handler: 400 con el mensaje si falla (validaciones del repo).
function manejar(fn, status = 400) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(status).json({ error: err.message, ...(err.errores && { errores: err.errores }) });
    }
  };
}

app.get('/api/admin/inventario', permisoInventario, manejar(
  (req) => inventarioRepo.listInventario({ ...parseInventarioFiltro(req.query), offset: Number(req.query.offset) || 0, limit: 100 }),
  500
));

app.get('/api/admin/inventario/export', permisoInventario, async (req, res) => {
  try {
    const rows = await inventarioRepo.listInventarioAll(parseInventarioFiltro(req.query));
    const csv = toCsv(
      rows.map((r) => ({
        ...r,
        proveedores: r.proveedores.map((p) => (p.sku_proveedor ? `${p.proveedor} (${p.sku_proveedor})` : p.proveedor)).join('; '),
        estado: r.discontinuado_at ? 'Descontinuado' : 'Activo',
      })),
      [
        { key: 'sku', label: 'SKU' },
        { key: 'nombre', label: 'Producto' },
        { key: 'categoria', label: 'Categoría' },
        { key: 'familia', label: 'Familia' },
        { key: 'stock', label: 'Stock' },
        { key: 'unidad_base', label: 'Unidad base' },
        { key: 'stock_minimo', label: 'Stock mínimo' },
        { key: 'semaforo', label: 'Semáforo' },
        { key: 'costo_promedio', label: 'Costo promedio' },
        { key: 'ultima_compra', label: 'Última compra' },
        { key: 'proveedores', label: 'Proveedores' },
        { key: 'estado', label: 'Estado' },
      ]
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventario.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/inventario/categorias', permisoInventario, manejar(async () => ({ rows: await inventarioRepo.listCategorias() }), 500));
app.post('/api/admin/inventario/categorias', permisoInventario, manejar(async (req) => ({ ok: true, categoria: await inventarioRepo.createCategoria(req.body || {}) })));
app.put('/api/admin/inventario/categorias/:id', permisoInventario, async (req, res) => {
  try {
    const categoria = await inventarioRepo.updateCategoria(req.params.id, req.body || {});
    if (!categoria) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ ok: true, categoria });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/inventario/proveedores', permisoInventario, manejar(async () => ({ rows: await proveedoresRepo.listProveedores() }), 500));
app.post('/api/admin/inventario/proveedores', permisoInventario, manejar(async (req) => ({ ok: true, proveedor: await proveedoresRepo.createProveedor(req.body || {}) })));
app.put('/api/admin/inventario/proveedores/:id', permisoInventario, async (req, res) => {
  try {
    const proveedor = await proveedoresRepo.updateProveedor(req.params.id, req.body || {});
    if (!proveedor) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json({ ok: true, proveedor });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/admin/inventario/proveedores/:id', permisoInventario, async (req, res) => {
  try {
    const ok = await proveedoresRepo.deleteProveedor(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SKU de los servicios, para elegir el SKU de un artículo de tienda.
app.get('/api/admin/inventario/skus-servicios', permisoInventario, manejar(async () => ({ rows: await inventarioRepo.listSkusServicios() }), 500));

// Próximo SKU para un insumo nuevo (solo vista previa: el definitivo se
// genera al guardar).
app.get('/api/admin/inventario/next-sku', permisoInventario, manejar(async (req) => ({ sku: await inventarioRepo.nextSku(Number(req.query.categoria_id) || null) })));

// Plantilla y carga del conteo inicial (Excel).
app.get('/api/admin/inventario/conteo-inicial/plantilla', permisoInventario, async (req, res) => {
  try {
    const wb = await inventarioRepo.plantillaConteoInicial();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="conteo-inicial.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/inventario/conteo-inicial', permisoInventario, express.raw({ type: '*/*', limit: '5mb' }), manejar(async (req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('No se recibió ningún archivo');
  return { ok: true, ...(await inventarioRepo.importarConteoInicial(req.body, req.user.id)) };
}));

app.post('/api/admin/inventario/bulk', permisoInventario, manejar(async (req) => {
  const { ids, filtro, accion, valor } = req.body || {};
  const actualizados = await inventarioRepo.bulk({ ids, filtro: filtro && parseInventarioFiltro(filtro), accion, valor });
  return { ok: true, actualizados };
}));

// Productos activos con lo necesario para armar las líneas de una compra.
app.get('/api/admin/inventario/opciones', permisoInventario, manejar(async () => ({ rows: await inventarioRepo.listOpciones() }), 500));

app.get('/api/admin/inventario/compras', permisoInventario, manejar(
  (req) => comprasRepo.listCompras({ offset: Number(req.query.offset) || 0 }),
  500
));

app.get('/api/admin/inventario/compras/:id(\\d+)', permisoInventario, async (req, res) => {
  try {
    const compra = await comprasRepo.getCompra(req.params.id);
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });
    res.json({ compra });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/inventario/compras', permisoInventario, manejar(
  async (req) => ({ ok: true, compra: await comprasRepo.createCompra(req.body || {}, req.user.id) })
));

app.post('/api/admin/inventario/compras/:id(\\d+)/anular', permisoInventario, manejar(
  async (req) => ({ ok: true, compra: await comprasRepo.anularCompra(req.params.id, req.user.id) })
));

app.get('/api/admin/inventario/:id(\\d+)/movimientos', permisoInventario, manejar(
  (req) => inventarioRepo.listMovimientos(req.params.id, { offset: Number(req.query.offset) || 0 }),
  500
));

app.post('/api/admin/inventario/:id(\\d+)/ajuste', permisoInventario, manejar(async (req) => ({
  ok: true,
  ...(await inventarioRepo.ajustarStock({ productoId: req.params.id, cantidad: (req.body || {}).cantidad, motivo: (req.body || {}).motivo, usuarioId: req.user.id })),
})));

app.post('/api/admin/inventario', permisoInventario, manejar(async (req) => ({ ok: true, producto: await inventarioRepo.createProducto(req.body || {}) })));

app.put('/api/admin/inventario/:id(\\d+)', permisoInventario, async (req, res) => {
  try {
    const producto = await inventarioRepo.updateProducto(req.params.id, req.body || {});
    if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, producto });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/inventario/:id(\\d+)', permisoInventario, async (req, res) => {
  try {
    const ok = await inventarioRepo.deleteProducto(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Cotizaciones
// ---------------------------------------------------------------------------

function parseCotizacionesParams(req) {
  const { q, estado, semaforo, documento, desde, hasta, offset } = req.query;
  return {
    q: q || null,
    estado: estado || null,
    semaforo: semaforo || null,
    documento: documento || null,
    desde: desde || null,
    hasta: hasta || null,
    offset: Number(offset) || 0,
    limit: 100,
  };
}

app.get('/api/admin/cotizaciones', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    res.json(await cotizacionesRepo.listCotizaciones(parseCotizacionesParams(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/cotizaciones/resumen', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const { semaforo, ...resto } = parseCotizacionesParams(req);
    res.json(await cotizacionesRepo.getResumen(resto));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Indica si el botón de "Enviar por correo" puede funcionar, para que la UI
// lo deshabilite con un motivo claro en vez de fallar al hacer clic.
app.get('/api/admin/cotizaciones/config', auth.requirePermission('cotizaciones'), (req, res) => {
  res.json({ mailConfigurado: mailer.mailConfigurado(), remitente: mailer.mailConfigurado() ? mailer.remitente() : null });
});

app.get('/api/admin/cotizaciones/:id', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.getCotizacion(req.params.id);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json(cotizacion);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// null = sin restricción (Admin ve/usa cualquier precio del tarifario).
function preciosPermitidosDe(req) {
  return req.user.es_admin ? null : req.user.permisos.precios;
}

app.post('/api/admin/cotizaciones', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.createCotizacion(req.body || {}, preciosPermitidosDe(req));
    res.json({ ok: true, cotizacion });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/cotizaciones/:id', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.updateCotizacion(req.params.id, req.body || {}, preciosPermitidosDe(req));
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json({ ok: true, cotizacion });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/cotizaciones/:id/items/:itemId/estado', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.setItemEstado(req.params.id, req.params.itemId, (req.body || {}).estado);
    if (!cotizacion) return res.status(404).json({ error: 'Ítem no encontrado' });
    res.json({ ok: true, cotizacion });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cotizaciones/:id/notas', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.addNota(req.params.id, (req.body || {}).texto);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json({ ok: true, cotizacion });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/cotizaciones/:id', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const ok = await cotizacionesRepo.deleteCotizacion(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ?descargar=1 fuerza la descarga; sin eso se abre en el visor del navegador,
// que es desde donde se imprime.
app.get('/api/admin/cotizaciones/:id/pdf', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.getCotizacion(req.params.id);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });

    const pdf = await generarCotizacionPdf(cotizacion);
    const disposition = req.query.descargar ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${nombreArchivo(cotizacion)}"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/cotizaciones/:id/email', auth.requirePermission('cotizaciones'), async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.getCotizacion(req.params.id);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });

    const destinatario = String((req.body || {}).destinatario || cotizacion.correo || '').trim();
    if (!destinatario) return res.status(400).json({ error: 'El cliente no tiene correo cargado. Escribí uno para enviar.' });
    if (!EMAIL_RE.test(destinatario)) return res.status(400).json({ error: 'El correo del destinatario no es válido' });

    const pdf = await generarCotizacionPdf(cotizacion);
    const saludo = cotizacion.apodo || (cotizacion.paciente || '').split(' ')[0] || '';
    const cuerpo = String((req.body || {}).mensaje || '').trim();
    const texto = cuerpo || `Hola ${saludo},\n\nTe compartimos la cotización ${cotizacion.numero} que preparamos para vos.\n\n¡Gracias por elegir Infinia!`;

    await mailer.enviarCorreo({
      to: destinatario,
      subject: `Cotización ${cotizacion.numero} — Infinia`,
      text: texto,
      html: `<p>${texto.replace(/\n/g, '<br />')}</p>`,
      attachments: [{ filename: nombreArchivo(cotizacion), content: pdf, contentType: 'application/pdf' }],
    });

    await cotizacionesRepo.registrarEnvio(cotizacion.id, destinatario);
    res.json({ ok: true, destinatario, cotizacion: await cotizacionesRepo.getCotizacion(cotizacion.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/clientes/:documento', auth.requirePermission('clientes'), async (req, res) => {
  try {
    const ok = await clientesRepo.deleteByDocumento(req.params.documento);
    if (!ok) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/asistencias/:id', auth.requirePermission('asistencias'), async (req, res) => {
  try {
    const ok = await asistenciasRepo.deleteById(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Asistencia no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cada pestaña del panel tiene su propia URL (/admin/servicios, /admin/usuarios,
// ...). Todas sirven el mismo SPA; el front lee el path para abrir la pestaña.
// Los assets (/admin/admin.js, /admin/admin.css) ya los resuelve express.static
// antes de llegar acá.
const ADMIN_TABS = ['dashboard', 'usuarios', 'asistencias', 'servicios', 'inventario', 'cotizaciones', 'cuentas'];

app.get('/admin/:tab', (req, res, next) => {
  if (!ADMIN_TABS.includes(req.params.tab)) return next();
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

usuariosRepo.bootstrapAdmin(auth.hashPassword).catch((err) => {
  console.error('Error creando la cuenta Admin inicial:', err);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
