const ExcelJS = require('exceljs');
const { pool } = require('./db');
const { segmento } = require('./serviciosRepo');

const UNIQUE_VIOLATION = '23505';
const INTENTOS_SKU = 5;

// Corre `fn(client)` dentro de una transacción (BEGIN/COMMIT, ROLLBACK si falla).
async function conTransaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function decimal(v, etiqueta, { positivo = false, allowNegative = false } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${etiqueta} debe ser un número`);
  if (!allowNegative && (positivo ? n <= 0 : n < 0)) throw new Error(`${etiqueta} debe ser ${positivo ? 'mayor a 0' : 'cero o más'}`);
  return n;
}

const redondear = (n, dec) => Math.round(n * 10 ** dec) / 10 ** dec;

// ---------------------------------------------------------------------------
// Costo promedio ponderado (por unidad base, IGV incluido)
//
// nuevo = (stock * promedio + entra * costo) / (stock + entra). Si el stock
// era <= 0 el promedio viejo ya no significa nada (no hay nada valorizado con
// ese costo), así que el nuevo costo lo reemplaza.
// ---------------------------------------------------------------------------
function promedioPonderado(stock, promedio, cantidad, costo) {
  if (stock <= 0) return costo;
  return (stock * promedio + cantidad * costo) / (stock + cantidad);
}

// Stock actual (suma del libro). Con `bloquear`, toma el lock de la fila del
// producto: sirve para serializar movimientos concurrentes sobre el mismo
// producto (el chequeo de stock y el insert no se pueden pisar).
async function leerStock(client, productoId, { bloquear = false } = {}) {
  const { rows: prod } = await client.query(
    `SELECT costo_promedio::float8 AS promedio FROM inventario WHERE id = $1 ${bloquear ? 'FOR UPDATE' : ''}`,
    [productoId]
  );
  if (!prod[0]) throw new Error('Producto no encontrado');
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(cantidad), 0)::float8 AS stock FROM movimientos WHERE producto_id = $1',
    [productoId]
  );
  return { stock: rows[0].stock, promedio: prod[0].promedio };
}

function insertarMovimiento(client, m) {
  return client.query(
    `INSERT INTO movimientos (producto_id, tipo, cantidad, costo_unitario, motivo, ref_tipo, ref_id, usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [m.productoId, m.tipo, m.cantidad, m.costoUnitario ?? null, m.motivo ?? null, m.refTipo ?? null, m.refId ?? null, m.usuarioId ?? null]
  );
}

// Entrada de stock (conteo inicial o compra): agrega el movimiento y, si trae
// costo, actualiza el promedio en la misma transacción. `cantidad` y
// `costoUnitario` van en unidad base.
async function registrarEntrada(client, m) {
  const { stock, promedio } = await leerStock(client, m.productoId, { bloquear: true });
  await insertarMovimiento(client, m);
  if (m.costoUnitario !== null && m.costoUnitario !== undefined) {
    const nuevo = redondear(promedioPonderado(stock, promedio, m.cantidad, m.costoUnitario), 6);
    await client.query('UPDATE inventario SET costo_promedio = $2, updated_at = now() WHERE id = $1', [m.productoId, nuevo]);
  }
}

// ---------------------------------------------------------------------------
// Listado
// ---------------------------------------------------------------------------

// El stock no es una columna: se suma del libro de movimientos. La consulta
// base lo calcula una vez y el listado filtra/ordena por encima (subselect `t`).
const BASE = `
  SELECT i.id, i.sku, i.nombre, i.descripcion, i.categoria_id,
         COALESCE(p.id, c.id)      AS categoria_padre_id,
         COALESCE(p.nombre, c.nombre) AS categoria,
         CASE WHEN p.id IS NOT NULL THEN c.id END     AS familia_id,
         CASE WHEN p.id IS NOT NULL THEN c.nombre END AS familia,
         i.unidad_base, i.unidad_compra,
         i.factor::float8         AS factor,
         i.stock_minimo::float8   AS stock_minimo,
         i.costo_promedio::float8 AS costo_promedio,
         i.discontinuado_at, i.reemplazado_por,
         COALESCE((SELECT SUM(m.cantidad) FROM movimientos m WHERE m.producto_id = i.id), 0)::float8 AS stock,
         (SELECT MAX(c.fecha) FROM compra_items ci JOIN compras c ON c.id = ci.compra_id
          WHERE ci.producto_id = i.id AND c.anulada_at IS NULL) AS ultima_compra,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'proveedor_id', s.proveedor_id, 'proveedor', pr.nombre, 'sku_proveedor', s.sku_proveedor
                  ) ORDER BY pr.nombre, s.sku_proveedor)
           FROM inventario_skus_proveedor s JOIN proveedores pr ON pr.id = s.proveedor_id
           WHERE s.producto_id = i.id
         ), '[]'::json) AS proveedores
  FROM inventario i
  LEFT JOIN inventario_categorias c ON c.id = i.categoria_id
  LEFT JOIN inventario_categorias p ON p.id = c.parent_id
`;

// Rojo: en el mínimo o debajo (incluye negativo). Amarillo: a menos de 10% del
// mínimo (o 1 unidad, lo que sea mayor) por encima. Sin mínimo, sin color.
const SEMAFORO = `
  CASE WHEN t.stock_minimo IS NULL THEN NULL
       WHEN t.stock <= t.stock_minimo THEN 'rojo'
       WHEN t.stock <= t.stock_minimo + GREATEST(0.1 * t.stock_minimo, 1) THEN 'amarillo'
       ELSE 'verde' END
`;

// Whitelist: el nombre de columna se interpola en el SQL.
const SORTABLE = {
  sku: 't.sku',
  nombre: 't.nombre',
  stock: 't.stock',
  stock_minimo: 't.stock_minimo',
  costo_promedio: 't.costo_promedio',
  ultima_compra: 't.ultima_compra',
};

function buildOrderBy(sort, dir) {
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const col = SORTABLE[sort];
  if (!col) return `t.categoria ${direction} NULLS LAST, t.familia ${direction} NULLS LAST, t.nombre, t.sku`;
  return `${col} ${direction} NULLS LAST, t.sku`;
}

function buildFilter(f, startIndex) {
  const conditions = [];
  const params = [];
  let i = startIndex;

  if (f.categoria_id) {
    conditions.push(`t.categoria_padre_id = $${i++}`);
    params.push(Number(f.categoria_id));
  }
  if (f.familia_id) {
    conditions.push(`t.familia_id = $${i++}`);
    params.push(Number(f.familia_id));
  }
  if (f.proveedor_id) {
    conditions.push(`EXISTS (SELECT 1 FROM inventario_skus_proveedor s WHERE s.producto_id = t.id AND s.proveedor_id = $${i++})`);
    params.push(Number(f.proveedor_id));
  }
  if (f.bajo_minimo) conditions.push('t.stock_minimo IS NOT NULL AND t.stock <= t.stock_minimo');
  if (f.stock_negativo) conditions.push('t.stock < 0');
  if (!f.descontinuados) conditions.push('t.discontinuado_at IS NULL');
  if (f.q) {
    conditions.push(
      `(t.sku ILIKE $${i} OR t.nombre ILIKE $${i}
        OR EXISTS (SELECT 1 FROM inventario_skus_proveedor s WHERE s.producto_id = t.id AND s.sku_proveedor ILIKE $${i}))`
    );
    params.push(`%${f.q}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, nextIndex: i };
}

async function listInventario({ sort, dir, offset = 0, limit = 100, ...filtro }) {
  const { where, params, nextIndex } = buildFilter(filtro, 1);
  const sql = `
    SELECT t.*, ${SEMAFORO} AS semaforo, COUNT(*) OVER()::int AS total,
           -- Valor del stock al costo promedio; el stock negativo no resta.
           COALESCE(SUM(GREATEST(t.stock, 0) * t.costo_promedio) OVER(), 0)::float8 AS valor_total
    FROM (${BASE}) t
    ${where}
    ORDER BY ${buildOrderBy(sort, dir)}
    LIMIT $${nextIndex} OFFSET $${nextIndex + 1}
  `;
  const { rows } = await pool.query(sql, [...params, limit + 1, offset]);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const total = rows.length ? rows[0].total : 0;
  const valorTotal = rows.length ? rows[0].valor_total : 0;
  page.forEach((r) => {
    delete r.total;
    delete r.valor_total;
  });
  return { rows: page, hasMore, total, valorTotal };
}

async function listInventarioAll({ sort, dir, ...filtro }) {
  const { where, params } = buildFilter(filtro, 1);
  const { rows } = await pool.query(
    `SELECT t.*, ${SEMAFORO} AS semaforo FROM (${BASE}) t ${where} ORDER BY ${buildOrderBy(sort, dir)}`,
    params
  );
  return rows;
}

async function getProducto(id, client = pool) {
  const { rows } = await client.query(`SELECT t.*, ${SEMAFORO} AS semaforo FROM (${BASE}) t WHERE t.id = $1`, [id]);
  return rows[0] || null;
}

// SKU y nombre de los servicios, para elegir el SKU de un artículo de tienda
// (que es el mismo del servicio con el que se vende).
async function listSkusServicios() {
  const { rows } = await pool.query('SELECT sku, nombre FROM servicios ORDER BY sku');
  return rows;
}

// ---------------------------------------------------------------------------
// Categorías (2 niveles: categoría y familia)
// ---------------------------------------------------------------------------

async function listCategorias() {
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.parent_id, c.activo,
            (SELECT count(*)::int FROM inventario i WHERE i.categoria_id = c.id) AS productos
     FROM inventario_categorias c
     ORDER BY c.activo DESC, c.nombre`
  );
  return rows;
}

async function createCategoria({ nombre, parent_id }) {
  const n = String(nombre || '').trim();
  if (!n) throw new Error('El nombre es requerido');
  const padre = parent_id ? Number(parent_id) : null;
  if (padre) {
    const { rows } = await pool.query('SELECT parent_id FROM inventario_categorias WHERE id = $1', [padre]);
    if (!rows[0]) throw new Error('La categoría padre no existe');
    if (rows[0].parent_id) throw new Error('Solo hay dos niveles: una familia no puede tener familias');
  }
  const { rows } = await pool.query(
    'INSERT INTO inventario_categorias (nombre, parent_id) VALUES ($1, $2) RETURNING id, nombre, parent_id, activo',
    [n, padre]
  );
  return rows[0];
}

async function updateCategoria(id, { nombre, activo }) {
  const n = String(nombre || '').trim();
  if (!n) throw new Error('El nombre es requerido');
  const { rows } = await pool.query(
    `UPDATE inventario_categorias SET nombre = $2, activo = COALESCE($3, activo)
     WHERE id = $1 RETURNING id, nombre, parent_id, activo`,
    [id, n, activo === undefined ? null : Boolean(activo)]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Generación de SKU
//
// Misma convención que el tarifario: 3 letras de la categoría + 3 de la
// familia + correlativo de 4 dígitos. El correlativo mira inventario Y
// servicios: un artículo de tienda comparte SKU con su servicio, así que un
// insumo nuevo no puede reusar un número que ya es de un servicio.
// ---------------------------------------------------------------------------

async function nextSku(categoriaId, client = pool) {
  const { rows: cat } = await client.query(
    `SELECT c.nombre, p.nombre AS padre FROM inventario_categorias c
     LEFT JOIN inventario_categorias p ON p.id = c.parent_id WHERE c.id = $1`,
    [categoriaId]
  );
  if (!cat[0]) throw new Error('La categoría es requerida para generar el SKU');
  const prefijo = cat[0].padre
    ? segmento(cat[0].padre) + segmento(cat[0].nombre)
    : segmento(cat[0].nombre) + segmento('');

  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(sku FROM 7 FOR 4)::int), 0) AS ultimo
     FROM (SELECT sku FROM inventario UNION ALL SELECT sku FROM servicios) t
     WHERE sku ~ ('^' || $1 || '[0-9]{4}$')`,
    [prefijo]
  );
  return prefijo + String(rows[0].ultimo + 1).padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Alta / edición de productos
// ---------------------------------------------------------------------------

function normalizarProducto(input) {
  const nombre = String(input.nombre || '').trim();
  if (!nombre) throw new Error('El nombre del producto es requerido');
  const unidadBase = String(input.unidad_base || '').trim() || 'unidad';
  const unidadCompra = String(input.unidad_compra || '').trim() || unidadBase;

  // Una misma combinación proveedor + SKU proveedor no se repite en el form.
  const vistos = new Set();
  const proveedores = [];
  for (const s of Array.isArray(input.proveedores) ? input.proveedores : []) {
    const proveedorId = Number(s.proveedor_id);
    if (!proveedorId) continue;
    const sku = String(s.sku_proveedor || '').trim() || null;
    const clave = `${proveedorId}|${sku}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    proveedores.push({ proveedorId, sku });
  }

  return {
    nombre,
    descripcion: String(input.descripcion || '').trim() || null,
    categoriaId: input.categoria_id ? Number(input.categoria_id) : null,
    unidadBase,
    unidadCompra,
    factor: decimal(input.factor, 'El factor', { positivo: true }) ?? 1,
    stockMinimo: decimal(input.stock_minimo, 'El stock mínimo'),
    proveedores,
  };
}

async function guardarProveedores(client, productoId, proveedores) {
  await client.query('DELETE FROM inventario_skus_proveedor WHERE producto_id = $1', [productoId]);
  for (const s of proveedores) {
    try {
      await client.query(
        'INSERT INTO inventario_skus_proveedor (producto_id, proveedor_id, sku_proveedor) VALUES ($1, $2, $3)',
        [productoId, s.proveedorId, s.sku]
      );
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) throw new Error(`El SKU de proveedor ${s.sku} ya está asignado a otro producto de ese proveedor`);
      throw err;
    }
  }
}

function insertarProducto(client, sku, p) {
  return client.query(
    `INSERT INTO inventario (sku, nombre, descripcion, categoria_id, unidad_base, unidad_compra, factor, stock_minimo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [sku, p.nombre, p.descripcion, p.categoriaId, p.unidadBase, p.unidadCompra, p.factor, p.stockMinimo]
  );
}

// Un SKU escrito/elegido a mano (p. ej. el de un servicio de la tienda) se
// respeta tal cual; si no viene se genera. Entre calcularlo e insertarlo otro
// admin pudo tomarlo: la violación de unicidad se reintenta con el siguiente.
async function createProducto(input) {
  const p = normalizarProducto(input);
  const skuManual = String(input.sku || '').trim().toUpperCase();
  if (!skuManual && !p.categoriaId) throw new Error('La categoría es requerida para generar el SKU');

  for (let intento = 0; intento < INTENTOS_SKU; intento++) {
    try {
      const id = await conTransaccion(async (client) => {
        const sku = skuManual || (await nextSku(p.categoriaId, client));
        const { rows } = await insertarProducto(client, sku, p);
        await guardarProveedores(client, rows[0].id, p.proveedores);
        return rows[0].id;
      });
      return getProducto(id);
    } catch (err) {
      if (err.code !== UNIQUE_VIOLATION) throw err;
      if (skuManual) throw new Error(`Ya existe un producto con el SKU ${skuManual}`);
    }
  }
  throw new Error('No se pudo generar un SKU libre. Intentá de nuevo o cargá el SKU a mano.');
}

// El SKU no se toca al editar (ni al recategorizar).
async function updateProducto(id, input) {
  const p = normalizarProducto(input);
  const ok = await conTransaccion(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE inventario SET nombre = $2, descripcion = $3, categoria_id = $4, unidad_base = $5,
              unidad_compra = $6, factor = $7, stock_minimo = $8, updated_at = now()
       WHERE id = $1`,
      [id, p.nombre, p.descripcion, p.categoriaId, p.unidadBase, p.unidadCompra, p.factor, p.stockMinimo]
    );
    if (!rowCount) return false;
    await guardarProveedores(client, id, p.proveedores);
    return true;
  });
  return ok ? getProducto(id) : null;
}

// Un producto con movimientos nunca se borra (rompería el historial): se
// descontinúa.
async function deleteProducto(id) {
  const { rows } = await pool.query('SELECT 1 FROM movimientos WHERE producto_id = $1 LIMIT 1', [id]);
  if (rows.length) throw new Error('El producto tiene movimientos: descontinualo en vez de borrarlo');
  try {
    const { rowCount } = await pool.query('DELETE FROM inventario WHERE id = $1', [id]);
    return rowCount > 0;
  } catch (err) {
    if (err.code === '23503') throw new Error('El producto está en uso: descontinualo en vez de borrarlo');
    throw err;
  }
}

// Recalcula el costo promedio repasando el libro del producto en orden. Se usa
// al anular una compra: las compras anuladas (y su reversa) se saltean, como si
// nunca hubieran pasado. Solo las entradas con costo mueven el promedio.
async function recalcularPromedio(client, productoId) {
  const { rows } = await client.query(
    `SELECT m.cantidad::float8 AS cantidad, m.costo_unitario::float8 AS costo
     FROM movimientos m
     LEFT JOIN compras c ON m.ref_tipo = 'compra' AND c.id = m.ref_id
     WHERE m.producto_id = $1 AND NOT (m.ref_tipo = 'compra' AND c.anulada_at IS NOT NULL)
     ORDER BY m.id`,
    [productoId]
  );
  let stock = 0;
  let promedio = 0;
  for (const m of rows) {
    if (m.cantidad > 0 && m.costo !== null) promedio = redondear(promedioPonderado(stock, promedio, m.cantidad, m.costo), 6);
    stock += m.cantidad;
  }
  await client.query('UPDATE inventario SET costo_promedio = $2, updated_at = now() WHERE id = $1', [productoId, promedio]);
  return promedio;
}

// Ajuste manual (+/-) en unidad base, con motivo obligatorio. No deja el stock
// bajo cero; el chequeo va dentro de la transacción con el producto bloqueado
// para que dos ajustes simultáneos no lo pisen.
async function ajustarStock({ productoId, cantidad, motivo, usuarioId }) {
  const n = decimal(cantidad, 'La cantidad', { allowNegative: true });
  if (!n) throw new Error('La cantidad del ajuste no puede ser 0');
  const razon = String(motivo || '').trim();
  if (!razon) throw new Error('El motivo es requerido');
  return conTransaccion(async (client) => {
    const { stock } = await leerStock(client, productoId, { bloquear: true });
    if (stock + n < 0) throw new Error(`El ajuste dejaría el stock en negativo (stock actual: ${stock})`);
    await insertarMovimiento(client, { productoId, tipo: 'ajuste', cantidad: n, motivo: razon, usuarioId });
    return { stock: redondear(stock + n, 4) };
  });
}

async function listMovimientos(productoId, { offset = 0, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT m.id, m.tipo, m.cantidad::float8 AS cantidad, m.costo_unitario::float8 AS costo_unitario,
            m.motivo, m.ref_tipo, m.ref_id, m.created_at, u.username AS usuario
     FROM movimientos m LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE m.producto_id = $1
     ORDER BY m.id DESC LIMIT $2 OFFSET $3`,
    [productoId, limit + 1, offset]
  );
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

// Productos activos para el buscador de líneas de una compra.
async function listOpciones() {
  const { rows } = await pool.query(
    `SELECT t.id, t.sku, t.nombre, t.unidad_base, t.unidad_compra, t.factor, t.proveedores
     FROM (${BASE}) t WHERE t.discontinuado_at IS NULL ORDER BY t.nombre, t.sku`
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Reposición: productos activos en el mínimo o debajo, agrupados por el
// proveedor de la última compra (vigente). Sin compras previas se usa el
// primer proveedor cargado en el producto; sin ninguno, "Sin proveedor".
// Sugerido = ceil((mínimo - stock) / factor) unidades de compra, al menos 1.
// ---------------------------------------------------------------------------
async function listReposicion() {
  const { rows } = await pool.query(
    `SELECT t.id, t.sku, t.nombre, t.unidad_base, t.unidad_compra, t.factor, t.stock, t.stock_minimo, t.proveedores,
            COALESCE(lp.proveedor_id, fp.proveedor_id) AS proveedor_id,
            COALESCE(lp.nombre, fp.nombre) AS proveedor
     FROM (${BASE}) t
     LEFT JOIN LATERAL (
       SELECT c.proveedor_id, p.nombre FROM compra_items ci
       JOIN compras c ON c.id = ci.compra_id JOIN proveedores p ON p.id = c.proveedor_id
       WHERE ci.producto_id = t.id AND c.anulada_at IS NULL
       ORDER BY c.fecha DESC, c.id DESC LIMIT 1
     ) lp ON true
     LEFT JOIN LATERAL (
       SELECT s.proveedor_id, p.nombre FROM inventario_skus_proveedor s
       JOIN proveedores p ON p.id = s.proveedor_id
       WHERE s.producto_id = t.id ORDER BY p.nombre LIMIT 1
     ) fp ON true
     WHERE t.discontinuado_at IS NULL AND t.stock_minimo IS NOT NULL AND t.stock <= t.stock_minimo
     ORDER BY COALESCE(lp.nombre, fp.nombre) NULLS LAST, t.nombre`
  );
  const grupos = new Map();
  for (const r of rows) {
    const clave = r.proveedor_id || 0;
    if (!grupos.has(clave)) grupos.set(clave, { proveedor_id: r.proveedor_id, proveedor: r.proveedor || 'Sin proveedor', items: [] });
    const skuProv = r.proveedores.find((s) => s.proveedor_id === r.proveedor_id && s.sku_proveedor);
    grupos.get(clave).items.push({
      id: r.id,
      sku: r.sku,
      nombre: r.nombre,
      sku_proveedor: skuProv ? skuProv.sku_proveedor : null,
      stock: r.stock,
      stock_minimo: r.stock_minimo,
      unidad_base: r.unidad_base,
      unidad_compra: r.unidad_compra,
      sugerido: Math.max(1, Math.ceil((r.stock_minimo - r.stock) / r.factor - 1e-9)),
    });
  }
  return [...grupos.values()];
}

// ---------------------------------------------------------------------------
// Descontinuar
// ---------------------------------------------------------------------------

async function descontinuar(client, ids, reemplazadoPor = null) {
  if (reemplazadoPor) {
    if (ids.includes(reemplazadoPor)) throw new Error('Un producto no puede reemplazarse a sí mismo');
    const { rows } = await client.query('SELECT discontinuado_at FROM inventario WHERE id = $1', [reemplazadoPor]);
    if (!rows[0]) throw new Error('El producto de reemplazo no existe');
    if (rows[0].discontinuado_at) throw new Error('El producto de reemplazo está descontinuado');
  }
  const { rowCount } = await client.query(
    `UPDATE inventario SET discontinuado_at = now(), reemplazado_por = $2, updated_at = now()
     WHERE id = ANY($1) AND discontinuado_at IS NULL`,
    [ids, reemplazadoPor]
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// Edición masiva. Recibe ids o el filtro actual ("seleccionar todos los que
// coinciden") y una acción.
// ---------------------------------------------------------------------------

async function bulk({ ids, filtro, accion, valor }) {
  let objetivo;
  if (Array.isArray(ids)) objetivo = ids.map(Number).filter(Boolean);
  else if (filtro) objetivo = (await listInventarioAll(filtro)).map((r) => r.id);
  else throw new Error('Indicá los productos a editar');
  if (!objetivo.length) throw new Error('No hay productos seleccionados');

  return conTransaccion(async (client) => {
    switch (accion) {
      case 'categoria': {
        const { rows } = await client.query('SELECT activo FROM inventario_categorias WHERE id = $1', [Number(valor)]);
        if (!rows[0]) throw new Error('La categoría no existe');
        if (!rows[0].activo) throw new Error('La categoría está desactivada');
        const r = await client.query('UPDATE inventario SET categoria_id = $2, updated_at = now() WHERE id = ANY($1)', [objetivo, Number(valor)]);
        return r.rowCount;
      }
      case 'proveedor': {
        // Agrega el proveedor a los productos que no lo tengan; los proveedores
        // (y SKU de proveedor) existentes no se tocan.
        const proveedorId = Number(valor);
        const { rows } = await client.query('SELECT 1 FROM proveedores WHERE id = $1', [proveedorId]);
        if (!rows[0]) throw new Error('El proveedor no existe');
        await client.query(
          `INSERT INTO inventario_skus_proveedor (producto_id, proveedor_id, sku_proveedor)
           SELECT i.id, $2, NULL FROM inventario i
           WHERE i.id = ANY($1)
             AND NOT EXISTS (SELECT 1 FROM inventario_skus_proveedor s WHERE s.producto_id = i.id AND s.proveedor_id = $2)`,
          [objetivo, proveedorId]
        );
        return objetivo.length;
      }
      case 'minimo': {
        const r = await client.query('UPDATE inventario SET stock_minimo = $2, updated_at = now() WHERE id = ANY($1)', [
          objetivo,
          decimal(valor, 'El stock mínimo'),
        ]);
        return r.rowCount;
      }
      case 'descontinuar':
        return descontinuar(client, objetivo);
      case 'reactivar': {
        const r = await client.query('UPDATE inventario SET discontinuado_at = NULL, reemplazado_por = NULL, updated_at = now() WHERE id = ANY($1)', [objetivo]);
        return r.rowCount;
      }
      default:
        throw new Error('Acción no válida');
    }
  });
}

// ---------------------------------------------------------------------------
// Conteo inicial por Excel: SKU | cantidad | costo_unitario (opcional).
// La cantidad va en unidad base y el costo es por unidad base, IGV incluido.
// Es todo o nada: si una fila falla no se carga ninguna.
// ---------------------------------------------------------------------------

function valorCelda(cell) {
  const v = cell.value;
  if (v && typeof v === 'object') return v.result !== undefined ? v.result : v.text ?? null;
  return v;
}

async function plantillaConteoInicial() {
  const { rows } = await pool.query(
    `SELECT i.sku, i.nombre, i.unidad_base FROM inventario i
     WHERE i.discontinuado_at IS NULL AND NOT EXISTS (SELECT 1 FROM movimientos m WHERE m.producto_id = i.id)
     ORDER BY i.sku`
  );
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Conteo inicial');
  ws.columns = [
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'cantidad', key: 'cantidad', width: 12 },
    { header: 'costo_unitario', key: 'costo', width: 16 },
    { header: 'nombre (referencia)', key: 'nombre', width: 40 },
    { header: 'unidad_base (referencia)', key: 'unidad', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow({ sku: r.sku, nombre: r.nombre, unidad: r.unidad_base }));
  const ayuda = wb.addWorksheet('Instrucciones');
  ayuda.getColumn(1).width = 100;
  [
    'cantidad: en la unidad base del producto (ml, unidad, par...), no en unidad de compra.',
    'costo_unitario (opcional): por unidad base, en soles, IGV incluido.',
    'Las columnas de referencia se ignoran al importar. Un producto que ya tiene movimientos no se puede volver a contar.',
  ].forEach((t) => ayuda.addRow([t]));
  return wb;
}

async function importarConteoInicial(buffer, usuarioId) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('No se pudo leer el archivo: tiene que ser un Excel (.xlsx)');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('El archivo no tiene hojas');

  const columnas = {};
  ws.getRow(1).eachCell((cell, n) => {
    const h = String(valorCelda(cell) || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (h === 'sku') columnas.sku = n;
    else if (h === 'cantidad') columnas.cantidad = n;
    else if (h === 'costo_unitario' || h === 'costo') columnas.costo = n;
  });
  if (!columnas.sku || !columnas.cantidad) throw new Error('Faltan las columnas SKU y cantidad en la primera fila');

  const filas = [];
  const errores = [];
  const vistos = new Set();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const sku = String(valorCelda(row.getCell(columnas.sku)) ?? '').trim().toUpperCase();
    const cantidadRaw = valorCelda(row.getCell(columnas.cantidad));
    if (!sku && (cantidadRaw === null || cantidadRaw === '')) return; // fila vacía
    try {
      if (!sku) throw new Error('falta el SKU');
      if (vistos.has(sku)) throw new Error(`el SKU ${sku} está repetido en el archivo`);
      vistos.add(sku);
      const cantidad = decimal(cantidadRaw, 'la cantidad');
      if (cantidad === null) throw new Error('falta la cantidad');
      const costoRaw = columnas.costo ? valorCelda(row.getCell(columnas.costo)) : null;
      filas.push({ fila: n, sku, cantidad, costo: decimal(costoRaw, 'el costo') });
    } catch (err) {
      errores.push({ fila: n, error: err.message });
    }
  });
  if (!filas.length && !errores.length) throw new Error('El archivo no tiene filas para cargar');

  return conTransaccion(async (client) => {
    const { rows } = await client.query(
      `SELECT i.id, i.sku, EXISTS (SELECT 1 FROM movimientos m WHERE m.producto_id = i.id) AS con_movimientos
       FROM inventario i WHERE i.sku = ANY($1)`,
      [filas.map((f) => f.sku)]
    );
    const porSku = new Map(rows.map((r) => [r.sku, r]));
    for (const f of filas) {
      const prod = porSku.get(f.sku);
      if (!prod) errores.push({ fila: f.fila, error: `no existe el SKU ${f.sku}` });
      else if (prod.con_movimientos) errores.push({ fila: f.fila, error: `${f.sku} ya tiene movimientos: corregilo con un ajuste` });
    }
    if (errores.length) {
      const err = new Error(`El archivo tiene ${errores.length} error(es); no se cargó nada`);
      err.errores = errores.sort((a, b) => a.fila - b.fila);
      throw err;
    }
    for (const f of filas) {
      await registrarEntrada(client, {
        productoId: porSku.get(f.sku).id,
        tipo: 'conteo_inicial',
        cantidad: f.cantidad,
        costoUnitario: f.costo,
        motivo: 'Conteo inicial',
        usuarioId,
      });
    }
    return { cargados: filas.length };
  });
}

module.exports = {
  conTransaccion,
  promedioPonderado,
  leerStock,
  insertarMovimiento,
  registrarEntrada,
  recalcularPromedio,
  ajustarStock,
  listMovimientos,
  listOpciones,
  listReposicion,
  decimal,
  redondear,
  listInventario,
  listInventarioAll,
  getProducto,
  listSkusServicios,
  listCategorias,
  createCategoria,
  updateCategoria,
  nextSku,
  createProducto,
  updateProducto,
  deleteProducto,
  descontinuar,
  bulk,
  plantillaConteoInicial,
  importarConteoInicial,
};
