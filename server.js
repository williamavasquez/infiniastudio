require('dotenv').config();
const path = require('path');
const express = require('express');
const clientesRepo = require('./lib/clientesRepo');
const asistenciasRepo = require('./lib/asistenciasRepo');
const adminRepo = require('./lib/adminRepo');
const productosRepo = require('./lib/productosRepo');
const cotizacionesRepo = require('./lib/cotizacionesRepo');
const { generarCotizacionPdf, nombreArchivo } = require('./lib/cotizacionPdf');
const mailer = require('./lib/mailer');
const adminAuth = require('./lib/adminAuth');
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

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!adminAuth.checkPassword(password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  adminAuth.setSessionCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  adminAuth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: adminAuth.isAuthenticated(req) });
});

// GET /api/admin/hoy -> { fecha: "YYYY-MM-DD" } — hoy en Perú, para que el
// front pueda prefijar filtros de fecha sin depender del timezone local.
app.get('/api/admin/hoy', adminAuth.requireAdminAuth, (req, res) => {
  res.json({ fecha: peruNow().fecha });
});

app.get('/api/admin/dashboard', adminAuth.requireAdminAuth, async (req, res) => {
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
  const { distrito, area, servicio, desde, hasta, q, offset } = req.query;
  return {
    distrito: distrito || null,
    area: area || null,
    servicio: servicio || null,
    desde: desde || null,
    hasta: hasta || null,
    q: q || null,
    offset: Number(offset) || 0,
    limit: 100,
  };
}

app.get('/api/admin/clientes', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const data = await adminRepo.listClientes(parseListParams(req));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/clientes/export', adminAuth.requireAdminAuth, async (req, res) => {
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

app.get('/api/admin/asistencias', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const data = await adminRepo.listAsistencias(parseListParams(req));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/asistencias/resumen', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const params = parseListParams(req);
    const data = await adminRepo.getResumenAsistencias(params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Productos (tarifario)
// ---------------------------------------------------------------------------

function parseProductosParams(req) {
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

app.get('/api/admin/productos', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const data = await productosRepo.listProductos(parseProductosParams(req));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Categorías y familias existentes, para los filtros y el formulario.
app.get('/api/admin/productos/facetas', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    res.json(await productosRepo.getFacetas());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listado liviano de productos, para elegir el "producto padre".
app.get('/api/admin/productos/opciones', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    res.json({ rows: await productosRepo.listOpciones() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Próximo SKU disponible, para previsualizarlo en el formulario. El SKU
// definitivo igual se genera al guardar (acá puede quedar obsoleto si otro
// admin crea un producto en el medio).
app.get('/api/admin/productos/next-sku', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const { categoria, familia, padre } = req.query;
    const sku = await productosRepo.nextSku({
      categoria: categoria || null,
      familia: familia || null,
      padre: padre || null,
    });
    res.json({ sku });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/productos/export', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const { q, categoria, familia, sort, dir } = req.query;
    const rows = await productosRepo.listProductosAll({
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
      { key: 'nombre', label: 'Producto' },
      { key: 'precio_regular', label: 'Precio regular' },
      { key: 'precio_oferta', label: 'Precio oferta' },
      { key: 'precio_max_desc', label: 'Precio máximo descuento' },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="productos.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/productos', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const producto = await productosRepo.createProducto(req.body || {});
    res.json({ ok: true, producto });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/productos/:sku', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const producto = await productosRepo.updateProducto(req.params.sku, req.body || {});
    if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, producto });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/productos/:sku', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const ok = await productosRepo.deleteProducto(req.params.sku);
    if (!ok) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.get('/api/admin/cotizaciones', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    res.json(await cotizacionesRepo.listCotizaciones(parseCotizacionesParams(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/cotizaciones/resumen', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const { semaforo, ...resto } = parseCotizacionesParams(req);
    res.json(await cotizacionesRepo.getResumen(resto));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Indica si el botón de "Enviar por correo" puede funcionar, para que la UI
// lo deshabilite con un motivo claro en vez de fallar al hacer clic.
app.get('/api/admin/cotizaciones/config', adminAuth.requireAdminAuth, (req, res) => {
  res.json({ mailConfigurado: mailer.mailConfigurado(), remitente: mailer.mailConfigurado() ? mailer.remitente() : null });
});

app.get('/api/admin/cotizaciones/:id', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.getCotizacion(req.params.id);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json(cotizacion);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/cotizaciones', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    res.json({ ok: true, cotizacion: await cotizacionesRepo.createCotizacion(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/cotizaciones/:id', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.updateCotizacion(req.params.id, req.body || {});
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json({ ok: true, cotizacion });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/cotizaciones/:id/estado', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.setEstado(req.params.id, (req.body || {}).estado);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json({ ok: true, cotizacion });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cotizaciones/:id/notas', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const cotizacion = await cotizacionesRepo.addNota(req.params.id, (req.body || {}).texto);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json({ ok: true, cotizacion });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/cotizaciones/:id', adminAuth.requireAdminAuth, async (req, res) => {
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
app.get('/api/admin/cotizaciones/:id/pdf', adminAuth.requireAdminAuth, async (req, res) => {
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

app.post('/api/admin/cotizaciones/:id/email', adminAuth.requireAdminAuth, async (req, res) => {
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

app.delete('/api/admin/clientes/:documento', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const ok = await clientesRepo.deleteByDocumento(req.params.documento);
    if (!ok) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/asistencias/:id', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const ok = await asistenciasRepo.deleteById(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Asistencia no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cada pestaña del panel tiene su propia URL (/admin/productos, /admin/usuarios,
// ...). Todas sirven el mismo SPA; el front lee el path para abrir la pestaña.
// Los assets (/admin/admin.js, /admin/admin.css) ya los resuelve express.static
// antes de llegar acá.
const ADMIN_TABS = ['dashboard', 'usuarios', 'asistencias', 'productos', 'cotizaciones'];

app.get('/admin/:tab', (req, res, next) => {
  if (!ADMIN_TABS.includes(req.params.tab)) return next();
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
