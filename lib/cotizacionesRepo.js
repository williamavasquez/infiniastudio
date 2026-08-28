const { pool } = require('./db');

// El semáforo no se guarda: se calcula al consultar desde la antigüedad de
// updated_at, así no hay que recalcular nada por cron ni queda desfasado.
// 'aceptada' y 'rechazada' son decisiones manuales y congelan el semáforo (una
// cotización rechazada no vuelve a ponerse roja por el paso del tiempo).
const SEMAFORO_SQL = `
  CASE
    WHEN c.estado = 'aceptada'  THEN 'aceptada'
    WHEN c.estado = 'rechazada' THEN 'rechazada'
    WHEN c.updated_at >= now() - interval '7 days'  THEN 'caliente'
    WHEN c.updated_at >= now() - interval '30 days' THEN 'tibio'
    WHEN c.updated_at >= now() - interval '90 days' THEN 'frio'
    ELSE 'vencida'
  END
`;

// Los ítems congelan nombre y precio al momento de cotizar, así que el total
// sale de la cotización misma y no del tarifario actual.
const TOTAL_SQL = `
  COALESCE((
    SELECT SUM(i.cantidad * i.precio_unitario)
    FROM cotizacion_items i
    WHERE i.cotizacion_id = c.id
  ), 0)::float8
`;

const COTIZACION_SELECT = `
  c.id,
  c.numero,
  c.documento,
  c.titulo,
  c.estado,
  c.validez_dias,
  c.observaciones,
  c.created_at,
  c.updated_at,
  ${SEMAFORO_SQL} AS semaforo,
  ${TOTAL_SQL} AS total,
  cl.paciente,
  cl.apodo,
  cl.correo,
  cl.celular,
  cl.tipo_doc,
  (SELECT count(*)::int FROM cotizacion_notas n WHERE n.cotizacion_id = c.id) AS notas_count,
  (SELECT max(e.enviado_at) FROM cotizacion_envios e WHERE e.cotizacion_id = c.id) AS ultimo_envio
`;

const ESTADOS = ['abierta', 'aceptada', 'rechazada'];
const SEMAFOROS = ['caliente', 'tibio', 'frio', 'vencida', 'aceptada', 'rechazada'];

function buildFilter({ q, estado, semaforo, documento, desde, hasta }, startIndex) {
  const conditions = [];
  const params = [];
  let i = startIndex;

  if (estado) {
    conditions.push(`c.estado = $${i++}`);
    params.push(estado);
  }
  if (semaforo) {
    conditions.push(`${SEMAFORO_SQL} = $${i++}`);
    params.push(semaforo);
  }
  if (documento) {
    conditions.push(`c.documento = $${i++}`);
    params.push(documento);
  }
  if (desde) {
    conditions.push(`c.created_at >= $${i++}`);
    params.push(desde);
  }
  if (hasta) {
    conditions.push(`c.created_at <= $${i++}`);
    params.push(`${hasta} 23:59:59`);
  }
  if (q) {
    conditions.push(
      `(c.numero ILIKE $${i} OR c.documento ILIKE $${i} OR cl.paciente ILIKE $${i} OR c.titulo ILIKE $${i})`
    );
    params.push(`%${q}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, nextIndex: i };
}

async function listCotizaciones({ q, estado, semaforo, documento, desde, hasta, offset = 0, limit = 100 }) {
  const { where, params, nextIndex } = buildFilter({ q, estado, semaforo, documento, desde, hasta }, 1);
  const sql = `
    SELECT ${COTIZACION_SELECT}, COUNT(*) OVER()::int AS total_filas
    FROM cotizaciones c
    JOIN clientes cl ON cl.documento = c.documento
    ${where}
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT $${nextIndex} OFFSET $${nextIndex + 1}
  `;
  const { rows } = await pool.query(sql, [...params, limit + 1, offset]);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const totalFilas = rows.length ? rows[0].total_filas : 0;
  page.forEach((r) => delete r.total_filas);
  return { rows: page, hasMore, total: totalFilas };
}

// Conteo por semáforo para las stat cards, respetando los filtros activos
// salvo el de semáforo (si no, siempre daría 1 sola columna con datos).
async function getResumen({ q, estado, documento, desde, hasta }) {
  const { where, params } = buildFilter({ q, estado, documento, desde, hasta }, 1);
  const sql = `
    SELECT ${SEMAFORO_SQL} AS semaforo, count(*)::int AS total, COALESCE(SUM(${TOTAL_SQL}), 0)::float8 AS monto
    FROM cotizaciones c
    JOIN clientes cl ON cl.documento = c.documento
    ${where}
    GROUP BY 1
  `;
  const { rows } = await pool.query(sql, params);
  const porSemaforo = Object.fromEntries(SEMAFOROS.map((s) => [s, 0]));
  let total = 0;
  let montoAceptado = 0;
  rows.forEach((r) => {
    porSemaforo[r.semaforo] = r.total;
    total += r.total;
    if (r.semaforo === 'aceptada') montoAceptado = r.monto;
  });
  return { total, porSemaforo, montoAceptado };
}

async function getCotizacion(id) {
  const { rows } = await pool.query(
    `SELECT ${COTIZACION_SELECT}
     FROM cotizaciones c
     JOIN clientes cl ON cl.documento = c.documento
     WHERE c.id = $1`,
    [id]
  );
  const cotizacion = rows[0];
  if (!cotizacion) return null;

  const [items, notas, envios] = await Promise.all([
    pool.query(
      `SELECT id, sku, nombre, cantidad, precio_unitario::float8 AS precio_unitario, tipo_precio, orden
       FROM cotizacion_items WHERE cotizacion_id = $1 ORDER BY orden, id`,
      [id]
    ),
    pool.query(
      'SELECT id, texto, created_at FROM cotizacion_notas WHERE cotizacion_id = $1 ORDER BY created_at DESC, id DESC',
      [id]
    ),
    pool.query(
      'SELECT id, destinatario, enviado_at FROM cotizacion_envios WHERE cotizacion_id = $1 ORDER BY enviado_at DESC',
      [id]
    ),
  ]);

  return { ...cotizacion, items: items.rows, notas: notas.rows, envios: envios.rows };
}

// COT-2026-0001: correlativo por año. Se calcula dentro de la transacción del
// alta y, si dos altas simultáneas sacan el mismo número, el UNIQUE de
// `numero` hace fallar una y se reintenta.
async function siguienteNumero(client) {
  const anio = new Date().getFullYear();
  const prefijo = `COT-${anio}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(numero FROM ${prefijo.length + 1})::int), 0) AS ultimo
     FROM cotizaciones
     WHERE numero ~ ('^' || $1 || '[0-9]{4}$')`,
    [prefijo]
  );
  return prefijo + String(rows[0].ultimo + 1).padStart(4, '0');
}

function normalizarItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('La cotización necesita al menos un ítem');
  }
  return items.map((item, indice) => {
    const nombre = String(item.nombre || '').trim();
    if (!nombre) throw new Error('Cada ítem necesita un nombre');

    const cantidad = Number(item.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1) {
      throw new Error(`Cantidad inválida en "${nombre}"`);
    }

    const precio = Number(item.precio_unitario);
    if (!Number.isFinite(precio) || precio < 0) {
      throw new Error(`Precio inválido en "${nombre}"`);
    }

    return {
      sku: String(item.sku || '').trim() || null,
      nombre,
      cantidad,
      precioUnitario: Math.round(precio * 100) / 100,
      tipoPrecio: String(item.tipo_precio || '').trim() || null,
      orden: indice,
    };
  });
}

function normalizarCabecera(input) {
  const validez = input.validez_dias === undefined || input.validez_dias === '' ? 30 : Number(input.validez_dias);
  if (!Number.isInteger(validez) || validez < 1) throw new Error('La validez debe ser un número de días mayor a 0');

  const estado = String(input.estado || 'abierta').trim();
  if (!ESTADOS.includes(estado)) throw new Error(`Estado inválido: ${estado}`);

  return {
    titulo: String(input.titulo || '').trim() || null,
    observaciones: String(input.observaciones || '').trim() || null,
    validez,
    estado,
  };
}

async function insertarItems(client, cotizacionId, items) {
  for (const it of items) {
    await client.query(
      `INSERT INTO cotizacion_items (cotizacion_id, sku, nombre, cantidad, precio_unitario, tipo_precio, orden)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [cotizacionId, it.sku, it.nombre, it.cantidad, it.precioUnitario, it.tipoPrecio, it.orden]
    );
  }
}

const UNIQUE_VIOLATION = '23505';
const INTENTOS_NUMERO = 5;

async function createCotizacion(input) {
  const documento = String(input.documento || '').trim();
  if (!documento) throw new Error('Elegí un cliente para la cotización');

  const cabecera = normalizarCabecera(input);
  const items = normalizarItems(input.items);

  for (let intento = 0; intento < INTENTOS_NUMERO; intento++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const numero = await siguienteNumero(client);
      const { rows } = await client.query(
        `INSERT INTO cotizaciones (numero, documento, titulo, estado, validez_dias, observaciones)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [numero, documento, cabecera.titulo, cabecera.estado, cabecera.validez, cabecera.observaciones]
      );
      await insertarItems(client, rows[0].id, items);
      await client.query('COMMIT');
      return getCotizacion(rows[0].id);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === UNIQUE_VIOLATION) continue;
      if (err.code === '23503') throw new Error(`No existe un cliente con documento ${documento}`);
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error('No se pudo generar el número de cotización. Intentá de nuevo.');
}

// Reemplaza los ítems completos (es más simple y predecible que diffear, y son
// pocas filas). Toca updated_at, con lo cual reinicia el semáforo.
async function updateCotizacion(id, input) {
  const cabecera = normalizarCabecera(input);
  const items = normalizarItems(input.items);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE cotizaciones
       SET titulo = $1, estado = $2, validez_dias = $3, observaciones = $4, updated_at = now()
       WHERE id = $5`,
      [cabecera.titulo, cabecera.estado, cabecera.validez, cabecera.observaciones, id]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('DELETE FROM cotizacion_items WHERE cotizacion_id = $1', [id]);
    await insertarItems(client, id, items);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getCotizacion(id);
}

async function setEstado(id, estado) {
  if (!ESTADOS.includes(estado)) throw new Error(`Estado inválido: ${estado}`);
  const { rowCount } = await pool.query(
    'UPDATE cotizaciones SET estado = $1, updated_at = now() WHERE id = $2',
    [estado, id]
  );
  return rowCount ? getCotizacion(id) : null;
}

// Una nota cuenta como actividad: reinicia el reloj del semáforo.
async function addNota(id, texto) {
  const limpio = String(texto || '').trim();
  if (!limpio) throw new Error('La nota no puede estar vacía');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      'UPDATE cotizaciones SET updated_at = now() WHERE id = $1',
      [id]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('INSERT INTO cotizacion_notas (cotizacion_id, texto) VALUES ($1, $2)', [id, limpio]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getCotizacion(id);
}

async function registrarEnvio(id, destinatario) {
  await pool.query('INSERT INTO cotizacion_envios (cotizacion_id, destinatario) VALUES ($1, $2)', [id, destinatario]);
}

async function deleteCotizacion(id) {
  const { rowCount } = await pool.query('DELETE FROM cotizaciones WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = {
  ESTADOS,
  SEMAFOROS,
  listCotizaciones,
  getResumen,
  getCotizacion,
  createCotizacion,
  updateCotizacion,
  setEstado,
  addNota,
  registrarEnvio,
  deleteCotizacion,
};
