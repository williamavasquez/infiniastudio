const { pool } = require('./db');

// Los precios se guardan como NUMERIC; pg los devuelve como string. Se
// castean a float8 para que el JSON lleve números y el front no tenga que
// parsear.
const PRODUCTO_SELECT = `
  sku,
  categoria,
  familia,
  nombre,
  precio_regular::float8 AS precio_regular,
  precio_oferta::float8  AS precio_oferta,
  precio_max_desc::float8 AS precio_max_desc,
  created_at,
  updated_at
`;

// Columnas por las que se puede ordenar desde la UI. Whitelist: el nombre de
// columna se interpola en el SQL, así que nunca puede venir del cliente tal cual.
const SORTABLE = {
  sku: 'sku',
  categoria: 'categoria',
  familia: 'familia',
  nombre: 'nombre',
  precio_regular: 'precio_regular',
  precio_oferta: 'precio_oferta',
  precio_max_desc: 'precio_max_desc',
};

function buildOrderBy(sort, dir) {
  const col = SORTABLE[sort] || 'categoria';
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // Desempate estable por SKU para que la paginación no repita ni salte filas.
  if (col === 'categoria') return `categoria ${direction}, familia ${direction} NULLS LAST, nombre ${direction}, sku`;
  return `${col} ${direction} NULLS LAST, sku`;
}

function buildFilter({ q, categoria, familia }, startIndex) {
  const conditions = [];
  const params = [];
  let i = startIndex;

  if (categoria) {
    conditions.push(`categoria = $${i++}`);
    params.push(categoria);
  }
  if (familia) {
    conditions.push(`familia = $${i++}`);
    params.push(familia);
  }
  if (q) {
    conditions.push(`(sku ILIKE $${i} OR nombre ILIKE $${i} OR familia ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, nextIndex: i };
}

async function listProductos({ q, categoria, familia, sort, dir, offset = 0, limit = 100 }) {
  const { where, params, nextIndex } = buildFilter({ q, categoria, familia }, 1);
  const sql = `
    SELECT ${PRODUCTO_SELECT}, COUNT(*) OVER()::int AS total
    FROM productos
    ${where}
    ORDER BY ${buildOrderBy(sort, dir)}
    LIMIT $${nextIndex} OFFSET $${nextIndex + 1}
  `;
  const { rows } = await pool.query(sql, [...params, limit + 1, offset]);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const total = rows.length ? rows[0].total : 0;
  page.forEach((r) => delete r.total);
  return { rows: page, hasMore, total };
}

async function listProductosAll({ q, categoria, familia, sort, dir }) {
  const { where, params } = buildFilter({ q, categoria, familia }, 1);
  const sql = `
    SELECT ${PRODUCTO_SELECT}
    FROM productos
    ${where}
    ORDER BY ${buildOrderBy(sort, dir)}
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Listado liviano (sin precios) de todos los productos, para el select de
// "producto padre" del formulario.
async function listOpciones() {
  const { rows } = await pool.query(
    `SELECT sku, categoria, familia, nombre
     FROM productos
     ORDER BY categoria, familia NULLS LAST, nombre, sku`
  );
  return rows;
}

// Categorías y familias existentes, para poblar los filtros y el formulario.
async function getFacetas() {
  const { rows } = await pool.query(
    `SELECT categoria, familia, count(*)::int AS total
     FROM productos
     GROUP BY categoria, familia
     ORDER BY categoria, familia NULLS LAST`
  );
  const categorias = [...new Set(rows.map((r) => r.categoria))];
  const familias = rows
    .filter((r) => r.familia)
    .map((r) => ({ categoria: r.categoria, familia: r.familia, total: r.total }));
  return { categorias, familias };
}

async function getProducto(sku) {
  const { rows } = await pool.query(`SELECT ${PRODUCTO_SELECT} FROM productos WHERE sku = $1`, [sku]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Generación de SKU
//
// El tarifario ya venía con una convención: 3 letras de la categoría + 3 de
// la familia + un correlativo de 4 dígitos (Estética + Toxina -> ESTTOX0001).
// Se respeta al generar SKU nuevos, con dos salvedades que salen de los datos
// reales:
//
//   - Algunas familias usan un prefijo histórico que no se deriva del nombre
//     (FACIAL -> ESTLIM, ENDOVENOSO -> ESTINY, RADIOFRECUENCIA -> ESTIND). Si
//     la familia ya tiene productos, se continúa SU prefijo en vez de inventar
//     uno nuevo.
//   - El correlativo se calcula sobre TODO el prefijo, no solo dentro de la
//     familia: PILREF0016 está en "Tienda Infinia" pero comparte la serie
//     PILREF con Pilates, y contar por familia chocaría con PILREF0017.
// ---------------------------------------------------------------------------

const SKU_ESTANDAR = /^([A-Z]{3})([A-Z]{3})(\d{4})$/;
// Sub-producto: el SKU del padre + sufijo -A, -B, -C...
const SKU_SUFIJO = /^(.*)-([A-Z])$/;

function segmento(texto) {
  const limpio = String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos: "Fórmulas" -> "FORMULAS"
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  if (!limpio) return 'GEN';
  return limpio.slice(0, 3).padEnd(3, 'X');
}

// Prefijo de 6 letras para una categoría/familia: el que ya usa esa familia
// si tiene productos, o uno derivado del nombre si es nueva.
async function resolverPrefijo(categoria, familia, client = pool) {
  const { rows } = await client.query(
    'SELECT sku FROM productos WHERE categoria = $1 AND familia IS NOT DISTINCT FROM $2',
    [categoria, familia]
  );

  const conteo = new Map();
  rows.forEach((r) => {
    const m = SKU_ESTANDAR.exec(r.sku);
    if (!m) return;
    const prefijo = m[1] + m[2];
    conteo.set(prefijo, (conteo.get(prefijo) || 0) + 1);
  });

  if (conteo.size) {
    // El más usado gana; empate resuelto alfabéticamente para que sea estable.
    return [...conteo.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }
  return segmento(categoria) + segmento(familia);
}

async function siguienteCorrelativo(prefijo, client = pool) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(sku FROM 7 FOR 4)::int), 0) AS ultimo
     FROM productos
     WHERE sku ~ ('^' || $1 || '[0-9]{4}$')`,
    [prefijo]
  );
  return rows[0].ultimo + 1;
}

async function generarSkuNuevo(categoria, familia, client = pool) {
  const prefijo = await resolverPrefijo(categoria, familia, client);
  const n = await siguienteCorrelativo(prefijo, client);
  return prefijo + String(n).padStart(4, '0');
}

// Sub-producto: toma el SKU base del padre (sin su propio sufijo, para que un
// sub-producto de CAPILAR001-A siga siendo hermano y no un nieto) y le pone
// la primera letra libre.
async function generarSubSku(skuPadre, client = pool) {
  const base = (SKU_SUFIJO.exec(skuPadre) || [null, skuPadre])[1];
  const { rows } = await client.query(
    'SELECT sku FROM productos WHERE sku = $1 OR sku LIKE $1 || $2',
    [base, '-_']
  );

  const usadas = new Set(
    rows.map((r) => (SKU_SUFIJO.exec(r.sku) || [])[2]).filter(Boolean)
  );
  for (let i = 0; i < 26; i++) {
    const letra = String.fromCharCode(65 + i);
    if (!usadas.has(letra)) return `${base}-${letra}`;
  }
  throw new Error(`El producto ${base} ya tiene 26 sub-productos`);
}

// Próximo SKU disponible. Con `padre` genera un sub-SKU; si no, un correlativo
// nuevo para la categoría/familia. La categoría y la familia se heredan del
// padre cuando no vienen.
async function nextSku({ categoria, familia, padre }, client = pool) {
  if (padre) {
    const productoPadre = await getProducto(String(padre).trim().toUpperCase());
    if (!productoPadre) throw new Error(`No existe el producto padre ${padre}`);
    return generarSubSku(productoPadre.sku, client);
  }
  if (!categoria) throw new Error('La categoría es requerida para generar el SKU');
  return generarSkuNuevo(String(categoria).trim(), String(familia || '').trim() || null, client);
}

function normalizarPrecio(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Los precios deben ser números');
  if (n < 0) throw new Error('Los precios no pueden ser negativos');
  return Math.round(n * 100) / 100;
}

function normalizarProducto(input, { skuOpcional = false } = {}) {
  const sku = String(input.sku || '').trim().toUpperCase();
  const categoria = String(input.categoria || '').trim();
  const nombre = String(input.nombre || '').trim();
  const familia = String(input.familia || '').trim() || null;

  if (!sku && !skuOpcional) throw new Error('El SKU es requerido');
  if (!categoria) throw new Error('La categoría es requerida');
  if (!nombre) throw new Error('El nombre del producto es requerido');

  return {
    sku,
    categoria,
    familia,
    nombre,
    precioRegular: normalizarPrecio(input.precio_regular),
    precioOferta: normalizarPrecio(input.precio_oferta),
    precioMaxDesc: normalizarPrecio(input.precio_max_desc),
  };
}

function insertarProducto(sku, p, client = pool) {
  return client.query(
    `INSERT INTO productos (sku, categoria, familia, nombre, precio_regular, precio_oferta, precio_max_desc)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${PRODUCTO_SELECT}`,
    [sku, p.categoria, p.familia, p.nombre, p.precioRegular, p.precioOferta, p.precioMaxDesc]
  );
}

// Si no viene un SKU, se genera. Entre calcularlo e insertarlo otro admin pudo
// tomarlo, así que la violación de unicidad (23505) se reintenta con el
// siguiente número en vez de fallarle al usuario.
const UNIQUE_VIOLATION = '23505';
const INTENTOS_SKU = 5;

async function createProducto(input) {
  const padre = input.padre ? String(input.padre).trim().toUpperCase() : null;
  const heredado = padre ? await getProducto(padre) : null;
  if (padre && !heredado) throw new Error(`No existe el producto padre ${padre}`);

  // Un sub-producto vive en la misma categoría/familia que su padre salvo que
  // se indique otra cosa.
  const p = normalizarProducto(
    heredado
      ? { categoria: heredado.categoria, familia: heredado.familia, ...input }
      : input,
    { skuOpcional: true }
  );

  if (p.sku) {
    const existente = await getProducto(p.sku);
    if (existente) throw new Error(`Ya existe un producto con el SKU ${p.sku}`);
    const { rows } = await insertarProducto(p.sku, p);
    return rows[0];
  }

  for (let intento = 0; intento < INTENTOS_SKU; intento++) {
    const sku = await nextSku({ categoria: p.categoria, familia: p.familia, padre });
    try {
      const { rows } = await insertarProducto(sku, p);
      return rows[0];
    } catch (err) {
      if (err.code !== UNIQUE_VIOLATION) throw err;
    }
  }
  throw new Error('No se pudo generar un SKU libre. Intentá de nuevo o cargá el SKU a mano.');
}

// El SKU es la llave primaria: se puede renombrar, pero solo si el nuevo no
// está tomado por otro producto.
async function updateProducto(skuActual, input) {
  const p = normalizarProducto(input);
  if (p.sku !== skuActual) {
    const existente = await getProducto(p.sku);
    if (existente) throw new Error(`Ya existe un producto con el SKU ${p.sku}`);
  }

  const { rows } = await pool.query(
    `UPDATE productos
     SET sku = $1, categoria = $2, familia = $3, nombre = $4,
         precio_regular = $5, precio_oferta = $6, precio_max_desc = $7,
         updated_at = now()
     WHERE sku = $8
     RETURNING ${PRODUCTO_SELECT}`,
    [p.sku, p.categoria, p.familia, p.nombre, p.precioRegular, p.precioOferta, p.precioMaxDesc, skuActual]
  );
  return rows[0] || null;
}

async function deleteProducto(sku) {
  const { rowCount } = await pool.query('DELETE FROM productos WHERE sku = $1', [sku]);
  return rowCount > 0;
}

module.exports = {
  nextSku,
  listProductos,
  listProductosAll,
  listOpciones,
  getFacetas,
  getProducto,
  createProducto,
  updateProducto,
  deleteProducto,
};
