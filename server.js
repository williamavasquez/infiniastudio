require('dotenv').config();
const path = require('path');
const express = require('express');
const clientesRepo = require('./lib/clientesRepo');
const asistenciasRepo = require('./lib/asistenciasRepo');
const distritos = require('./lib/distritos.json');

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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
