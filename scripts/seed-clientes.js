require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { pool } = require('../lib/db');

const XLSX_PATH = path.join(__dirname, '..', 'data', 'clientes.xlsx');
const SHEET_NAME = 'Clientes';

const COLUMNS = [
  'FECHA_CREACION',
  'DOCUMENTO',
  'TIPO_DOC',
  'PACIENTE',
  'RUC',
  'CELULAR',
  'DISTRITO',
  'F_NACIMIENTO',
  'EDAD',
  'CORREO',
  'DIRECCION',
];

function toNullIfBlank(v) {
  const s = (v ?? '').toString().trim();
  return s === '' ? null : s;
}

// The source spreadsheet has a pivot-table leftover placeholder for blank
// documento cells — treat it as no document, not a literal client ID.
const BLANK_PLACEHOLDER = '(en blanco)';

function isRealDocumento(doc) {
  return !!doc && doc.toLowerCase() !== BLANK_PLACEHOLDER;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function toValidDateOrNull(v, documento, warnings) {
  const s = toNullIfBlank(v);
  if (s === null) return null;
  if (!ISO_DATE_RE.test(s)) {
    warnings.push(`DOCUMENTO ${documento}: F_NACIMIENTO inválida ("${s}") — se guarda como null`);
    return null;
  }
  return s;
}

function toValidTimestampOrNull(v, documento, warnings) {
  const s = toNullIfBlank(v);
  if (s === null) return null;
  if (!ISO_TIMESTAMP_RE.test(s)) {
    warnings.push(`DOCUMENTO ${documento}: FECHA_CREACION inválida ("${s}") — se guarda como null`);
    return null;
  }
  return s;
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`No se encontró la hoja "${SHEET_NAME}" en ${XLSX_PATH}`);

  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values.slice(1);
    const record = {};
    COLUMNS.forEach((field, i) => {
      record[field] = toNullIfBlank(values[i]);
    });
    if (isRealDocumento(record.DOCUMENTO)) rows.push(record);
  });

  console.log(`Insertando/actualizando ${rows.length} clientes...`);

  const warnings = [];
  let count = 0;
  for (const r of rows) {
    r.F_NACIMIENTO = toValidDateOrNull(r.F_NACIMIENTO, r.DOCUMENTO, warnings);
    r.FECHA_CREACION = toValidTimestampOrNull(r.FECHA_CREACION, r.DOCUMENTO, warnings);
    await pool.query(
      `INSERT INTO clientes (documento, tipo_doc, paciente, ruc, celular, distrito, f_nacimiento, correo, direccion, fecha_creacion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (documento) DO UPDATE SET
         tipo_doc = EXCLUDED.tipo_doc,
         paciente = EXCLUDED.paciente,
         ruc = EXCLUDED.ruc,
         celular = EXCLUDED.celular,
         distrito = EXCLUDED.distrito,
         f_nacimiento = EXCLUDED.f_nacimiento,
         correo = EXCLUDED.correo,
         direccion = EXCLUDED.direccion`,
      [
        r.DOCUMENTO,
        r.TIPO_DOC,
        r.PACIENTE || r.DOCUMENTO,
        r.RUC,
        r.CELULAR,
        r.DISTRITO,
        r.F_NACIMIENTO,
        r.CORREO,
        r.DIRECCION,
        r.FECHA_CREACION,
      ]
    );
    count += 1;
  }

  console.log(`Listo: ${count} clientes cargados en Postgres.`);
  if (warnings.length) {
    console.log(`\n${warnings.length} advertencias (fechas de nacimiento inválidas en el Excel de origen):`);
    warnings.slice(0, 20).forEach((w) => console.log(' -', w));
    if (warnings.length > 20) console.log(`   ...y ${warnings.length - 20} más`);
  }
  await pool.end();
})().catch((err) => {
  console.error('Error en la migración:', err);
  process.exit(1);
});
