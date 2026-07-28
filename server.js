require('dotenv').config();
const path = require('path');
const express = require('express');
const clientesRepo = require('./lib/clientesRepo');
const asistenciasRepo = require('./lib/asistenciasRepo');
const adminRepo = require('./lib/adminRepo');
const adminAuth = require('./lib/adminAuth');
const { toCsv } = require('./lib/csv');
const distritos = require('./lib/distritos.json');
const { CATEGORIAS } = require('./lib/asistenciasRepo');

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

// POST /api/clientes -> crea o actualiza (por DOCUMENTO)
app.post('/api/clientes', async (req, res) => {
  const input = req.body || {};

  if (!input.DOCUMENTO || !String(input.DOCUMENTO).trim()) {
    return res.status(400).json({ error: 'DOCUMENTO es requerido' });
  }
  if (!input.PACIENTE || !String(input.PACIENTE).trim()) {
    return res.status(400).json({ error: 'PACIENTE es requerido' });
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

// POST /api/asistencias -> registra un check-in (fecha/hora/turno automáticos, tipo_doc/paciente desde la BD)
app.post('/api/asistencias', async (req, res) => {
  const { NRO_DOC, CATEGORIA } = req.body || {};

  if (!NRO_DOC || !String(NRO_DOC).trim()) {
    return res.status(400).json({ error: 'NRO_DOC es requerido' });
  }

  try {
    const asistencia = await asistenciasRepo.createAsistencia({
      nroDocumento: String(NRO_DOC).trim(),
      categoria: CATEGORIA,
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

app.get('/api/admin/dashboard', adminAuth.requireAdminAuth, async (req, res) => {
  try {
    const data = await adminRepo.getDashboard();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseListParams(req) {
  const { distrito, categoria, desde, hasta, q, offset } = req.query;
  return {
    distrito: distrito || null,
    categoria: categoria || null,
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
    const { distrito, categoria, desde, hasta, q } = req.query;
    const rows = await adminRepo.listClientesAll({
      distrito: distrito || null,
      categoria: categoria || null,
      desde: desde || null,
      hasta: hasta || null,
      q: q || null,
    });
    const csv = toCsv(rows, [
      { key: 'documento', label: 'Documento' },
      { key: 'tipo_doc', label: 'Tipo Doc' },
      { key: 'paciente', label: 'Paciente' },
      { key: 'apodo', label: 'Apodo' },
      { key: 'ruc', label: 'RUC' },
      { key: 'celular', label: 'Celular' },
      { key: 'distrito', label: 'Distrito' },
      { key: 'f_nacimiento', label: 'F Nacimiento' },
      { key: 'correo', label: 'Correo' },
      { key: 'direccion', label: 'Dirección' },
      { key: 'fecha_creacion', label: 'Fecha Creación' },
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

app.get('/api/admin/categorias', adminAuth.requireAdminAuth, (req, res) => {
  res.json(CATEGORIAS);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
