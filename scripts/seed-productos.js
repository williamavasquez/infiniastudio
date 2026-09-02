// Carga el tarifario (data/Tarifario_Infinia_Equipo_Agosto_2026.xlsx) en la
// tabla `productos`. Cada pestaña del Excel es una categoría.
//
// Sobre los SKU: el SKU es el id del producto, pero en el Excel algunos SKU
// del bloque capilar se repiten en más de un "Programa" (familia) con los
// mismos precios. Esos se convierten en sub-SKU con sufijo -A, -B, -C, en el
// orden en que aparecen en la hoja. Las filas idénticas por completo (mismo
// SKU, familia, nombre y precios) se colapsan en una sola.
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { pool } = require('../lib/db');

const ARCHIVO = path.join(__dirname, '..', 'data', 'Tarifario_Infinia_Equipo_Agosto_2026.xlsx');

// Fila 1 = título de la hoja, fila 2 = encabezados, los datos arrancan en la 3.
const PRIMERA_FILA_DATOS = 3;

function texto(v) {
  if (v === null || v === undefined) return null;
  const s = String(typeof v === 'object' && v.text ? v.text : v).trim();
  return s || null;
}

// Los precios del Excel arrastran ruido de punto flotante (112.49999999999999).
function precio(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(typeof v === 'object' && v.result !== undefined ? v.result : v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function leerFilas(worksheet) {
  const filas = [];
  worksheet.eachRow((row, numero) => {
    if (numero < PRIMERA_FILA_DATOS) return;
    const [, familia, sku, nombre, regular, oferta, maxDesc] = row.values;
    const skuLimpio = texto(sku);
    const nombreLimpio = texto(nombre);
    if (!skuLimpio || !nombreLimpio) return;
    filas.push({
      categoria: worksheet.name.trim(),
      familia: texto(familia),
      sku: skuLimpio.toUpperCase(),
      nombre: nombreLimpio,
      precioRegular: precio(regular),
      precioOferta: precio(oferta),
      precioMaxDesc: precio(maxDesc),
    });
  });
  return filas;
}

function huella(f) {
  return [f.categoria, f.familia, f.sku, f.nombre, f.precioRegular, f.precioOferta, f.precioMaxDesc].join('|');
}

// 1) Elimina duplicados exactos. 2) Si un SKU sigue apareciendo en más de una
// fila, cada una recibe un sufijo -A, -B, -C...
function asignarSkus(filas) {
  const vistas = new Set();
  const unicas = filas.filter((f) => {
    const h = huella(f);
    if (vistas.has(h)) return false;
    vistas.add(h);
    return true;
  });

  const conteo = new Map();
  unicas.forEach((f) => conteo.set(f.sku, (conteo.get(f.sku) || 0) + 1));

  const usados = new Map();
  return unicas.map((f) => {
    if (conteo.get(f.sku) === 1) return { ...f, skuOriginal: f.sku };
    const n = usados.get(f.sku) || 0;
    usados.set(f.sku, n + 1);
    return { ...f, skuOriginal: f.sku, sku: `${f.sku}-${String.fromCharCode(65 + n)}` };
  });
}

(async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(ARCHIVO);

  let crudas = [];
  workbook.eachSheet((ws) => {
    crudas = crudas.concat(leerFilas(ws));
  });

  const productos = asignarSkus(crudas);
  const colapsadas = crudas.length - productos.length;
  const sufijadas = productos.filter((p) => p.sku !== p.skuOriginal);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of productos) {
      await client.query(
        `INSERT INTO productos (sku, categoria, familia, nombre, precio_regular, precio_oferta, precio_max_desc)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sku) DO UPDATE SET
           categoria = EXCLUDED.categoria,
           familia = EXCLUDED.familia,
           nombre = EXCLUDED.nombre,
           precio_regular = EXCLUDED.precio_regular,
           precio_oferta = EXCLUDED.precio_oferta,
           precio_max_desc = EXCLUDED.precio_max_desc,
           updated_at = now()`,
        [p.sku, p.categoria, p.familia, p.nombre, p.precioRegular, p.precioOferta, p.precioMaxDesc]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const porCategoria = productos.reduce((acc, p) => {
    acc[p.categoria] = (acc[p.categoria] || 0) + 1;
    return acc;
  }, {});

  console.log(`Productos cargados: ${productos.length} (de ${crudas.length} filas del Excel)`);
  Object.entries(porCategoria).forEach(([cat, n]) => console.log(`  - ${cat}: ${n}`));
  if (colapsadas) console.log(`Filas duplicadas exactas colapsadas: ${colapsadas}`);
  if (sufijadas.length) {
    console.log(`SKU repetidos convertidos en sub-SKU: ${sufijadas.length}`);
    sufijadas.forEach((p) => console.log(`  - ${p.skuOriginal} -> ${p.sku} (${p.familia})`));
  }

  await pool.end();
})().catch((err) => {
  console.error('Error cargando el tarifario:', err);
  process.exit(1);
});
