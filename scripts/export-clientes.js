// One-time export: reads the Clientes sheet from the master workbook
// (read-only, never touches the master file) and writes a clean,
// standalone data/clientes.xlsx with just those 11 columns.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const MASTER_PATH = path.join(__dirname, '..', 'data', 'Infinia_AsistenciayPagos2026_vf (5).xlsx');
const OUT_PATH = path.join(__dirname, '..', 'data', 'clientes.xlsx');
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
const DATE_FIELDS = new Set(['F_NACIMIENTO']);

function excelSerialToISODate(serial) {
  const ms = Date.UTC(1899, 11, 30) + Number(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function colLetterFromRef(ref) {
  return ref.match(/^([A-Z]+)\d+$/)[1];
}

function colIndexFromLetter(letter) {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml) {
  const items = [];
  const siRegex = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRegex.exec(xml))) {
    const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]);
    items.push(decodeXmlEntities(texts.join('')));
  }
  return items;
}

function parseRows(sheetDataInner, sharedStrings) {
  const rowRegex = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>|<row[^>]*\br="(\d+)"[^>]*\/>/g;
  const cellRegex = /<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>|<c r="([A-Z]+\d+)"([^>]*)\/>/g;
  const rows = [];
  let m;
  while ((m = rowRegex.exec(sheetDataInner))) {
    const rowNum = parseInt(m[1] || m[3], 10);
    const rowInner = m[2] || '';
    const record = {};
    COLUMNS.forEach((c) => (record[c] = ''));

    cellRegex.lastIndex = 0;
    let cm;
    while ((cm = cellRegex.exec(rowInner))) {
      const ref = cm[1] || cm[4];
      const attrs = cm[2] || cm[5] || '';
      const inner = cm[3] || '';
      const colIdx = colIndexFromLetter(colLetterFromRef(ref));
      if (colIdx < 0 || colIdx >= COLUMNS.length) continue;
      const field = COLUMNS[colIdx];

      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : null;

      let value = '';
      if (type === 's') {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const idx = vMatch ? parseInt(vMatch[1], 10) : -1;
        value = sharedStrings[idx] || '';
      } else if (type === 'inlineStr' || type === 'str') {
        const tMatch = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = tMatch ? decodeXmlEntities(tMatch[1]) : '';
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const raw = vMatch ? vMatch[1] : '';
        if (raw && DATE_FIELDS.has(field) && /^\d+(\.\d+)?$/.test(raw)) {
          value = excelSerialToISODate(raw);
        } else {
          value = raw;
        }
      }
      record[field] = typeof value === 'string' ? value.trim() : value;
    }
    rows.push({ rowNum, record });
  }
  return rows;
}

async function findSheetPath(zip) {
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const sheetMatch = workbookXml.match(new RegExp(`<sheet[^>]*name="${SHEET_NAME}"[^>]*/>`));
  const rid = sheetMatch[0].match(/r:id="(rId\d+)"/)[1];
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relMatch = relsXml.match(new RegExp(`<Relationship Id="${rid}"[^>]*Target="([^"]+)"`));
  return `xl/${relMatch[1]}`;
}

(async () => {
  const buf = fs.readFileSync(MASTER_PATH);
  const zip = await JSZip.loadAsync(buf);
  const sheetPath = await findSheetPath(zip);
  const sheetXml = await zip.file(sheetPath).async('string');
  const sharedStringsXml = await zip.file('xl/sharedStrings.xml').async('string');
  const sharedStrings = parseSharedStrings(sharedStringsXml);

  const sheetDataInner = sheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/)[1];
  const allRows = parseRows(sheetDataInner, sharedStrings);
  const dataRows = allRows.filter((r) => r.rowNum > 1);

  console.log(`Encontrados ${dataRows.length} clientes en la hoja "${SHEET_NAME}" del archivo maestro.`);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME);
  ws.addRow(COLUMNS);
  dataRows.forEach((r) => {
    ws.addRow(COLUMNS.map((f) => r.record[f] ?? ''));
  });

  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`Escrito: ${OUT_PATH}`);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
