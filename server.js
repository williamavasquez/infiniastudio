const fs = require('fs');
const path = require('path');
const express = require('express');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// CONFIG — edit this once you tell me the real Excel file / sheet / columns.
// ---------------------------------------------------------------------------
const EXCEL_PATH = path.join(__dirname, 'data', 'registros.xlsx');
const SHEET_NAME = 'Registros';

// Column headers used in the spreadsheet (first row). Keep these in sync
// with the field names sent from the form in public/app.js.
const COLUMNS = ['Fecha', 'DNI', 'Nombre', 'Apellido', 'FechaNacimiento'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Excel helpers
// ---------------------------------------------------------------------------
async function ensureWorkbook() {
  if (fs.existsSync(EXCEL_PATH)) return;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME);
  ws.addRow(COLUMNS);
  fs.mkdirSync(path.dirname(EXCEL_PATH), { recursive: true });
  await wb.xlsx.writeFile(EXCEL_PATH);
}

async function readRows() {
  await ensureWorkbook();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) return [];

  const headerRow = ws.getRow(1).values; // 1-indexed, [empty, col1, col2, ...]
  const headers = headerRow.slice(1).map((h) => String(h));

  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values.slice(1);
    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = values[i] ?? '';
    });
    rows.push(obj);
  });
  return rows;
}

async function writeRows(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME);
  ws.addRow(COLUMNS);
  rows.forEach((row) => {
    ws.addRow(COLUMNS.map((col) => row[col] ?? ''));
  });
  await wb.xlsx.writeFile(EXCEL_PATH);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// GET /api/lookup/:dni -> { found: true, registro: {...} } | { found: false }
app.get('/api/lookup/:dni', async (req, res) => {
  const dni = String(req.params.dni).trim();
  const rows = await readRows();
  const match = rows.find((r) => String(r.DNI).trim() === dni);
  if (match) {
    res.json({ found: true, registro: match });
  } else {
    res.json({ found: false });
  }
});

// POST /api/registros -> guarda (crea o actualiza por DNI) un registro
app.post('/api/registros', async (req, res) => {
  const registro = req.body || {};
  if (!registro.DNI) {
    return res.status(400).json({ error: 'DNI es requerido' });
  }

  const rows = await readRows();
  const idx = rows.findIndex((r) => String(r.DNI).trim() === String(registro.DNI).trim());

  const row = {};
  COLUMNS.forEach((col) => {
    row[col] = registro[col] ?? '';
  });

  if (idx >= 0) {
    rows[idx] = row;
  } else {
    rows.push(row);
  }

  await writeRows(rows);
  res.json({ ok: true, registro: row });
});

app.listen(PORT, async () => {
  await ensureWorkbook();
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Archivo Excel: ${EXCEL_PATH}`);
});
