const { pool } = require('./db');

// El estado de la cotización ya no se guarda a mano: se deriva de los estados
// de sus ítems (aceptación parcial). 'abierta' si todos están pendientes,
// 'aceptada'/'rechazada' si todos coinciden, 'parcial' si están mezclados.
const ESTADO_ITEMS_SQL = `(
  SELECT CASE
    WHEN COUNT(*) = 0 THEN 'abierta'
    WHEN COUNT(*) FILTER (WHERE i.estado = 'aceptado')  = COUNT(*) THEN 'aceptada'
    WHEN COUNT(*) FILTER (WHERE i.estado = 'rechazado') = COUNT(*) THEN 'rechazada'
    WHEN COUNT(*) FILTER (WHERE i.estado = 'pendiente') = COUNT(*) THEN 'abierta'
    ELSE 'parcial'
  END
  FROM cotizacion_items i
  WHERE i.cotizacion_id = c.id
)`;

// El semáforo no se guarda: se calcula al consultar desde la antigüedad de
// updated_at, así no hay que recalcular nada por cron ni queda desfasado.
// 'aceptada' y 'rechazada' (cuando TODOS los ítems quedaron así) congelan el
// semáforo — una cotización totalmente resuelta no vuelve a ponerse roja por
// el paso del tiempo. Una cotización 'parcial' sigue envejeciendo, porque
// todavía hay ítems pendientes de seguimiento.
const SEMAFORO_SQL = `
  CASE
    WHEN ${ESTADO_ITEMS_SQL} = 'aceptada'  THEN 'aceptada'
    WHEN ${ESTADO_ITEMS_SQL} = 'rechazada' THEN 'rechazada'
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
  ${ESTADO_ITEMS_SQL} AS estado,
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

// 'abierta'/'aceptada'/'rechazada'/'parcial' son valores derivados de los
// ítems (ver ESTADO_ITEMS_SQL), no se setean a mano. ITEM_ESTADOS es lo único
// que se acepta como input al aceptar/rechazar un ítem.
const ESTADOS = ['abierta', 'aceptada', 'rechazada', 'parcial'];
const ITEM_ESTADOS = ['pendiente', 'aceptado', 'rechazado'];
const ITEM_ESTADO_LABEL = { pendiente: 'vuelto a pendiente', aceptado: 'aceptado', rechazado: 'rechazado' };
const SEMAFOROS = ['caliente', 'tibio', 'frio', 'vencida', 'aceptada', 'rechazada'];

function buildFilter({ q, estado, semaforo, documento, desde, hasta }, startIndex) {
  const conditions = [];
  const params = [];
  let i = startIndex;

  if (estado) {
    conditions.push(`${ESTADO_ITEMS_SQL} = $${i++}`);
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

  const [items, notas, historial, envios] = await Promise.all([
    pool.query(
      `SELECT id, sku, nombre, cantidad, precio_unitario::float8 AS precio_unitario, tipo_precio, estado, orden
       FROM cotizacion_items WHERE cotizacion_id = $1 ORDER BY orden, id`,
      [id]
    ),
    pool.query(
      'SELECT id, texto, created_at FROM cotizacion_notas WHERE cotizacion_id = $1 ORDER BY created_at DESC, id DESC',
      [id]
    ),
    pool.query(
      'SELECT id, tipo, detalle, created_at FROM cotizacion_historial WHERE cotizacion_id = $1 ORDER BY created_at DESC, id DESC',
      [id]
    ),
    pool.query(
      'SELECT id, destinatario, enviado_at FROM cotizacion_envios WHERE cotizacion_id = $1 ORDER BY enviado_at DESC',
      [id]
    ),
  ]);

  // "Actividad": notas manuales + eventos automáticos (ítems, estados),
  // mezclados en una sola línea de tiempo tipo Jira, más reciente primero.
  const actividad = [
    ...notas.rows.map((n) => ({ tipo: 'nota', detalle: n.texto, created_at: n.created_at })),
    ...historial.rows.map((h) => ({ tipo: h.tipo, detalle: h.detalle, created_at: h.created_at })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return { ...cotizacion, items: items.rows, notas: notas.rows, actividad, envios: envios.rows };
}

async function registrarHistorial(client, cotizacionId, tipo, detalle) {
  await client.query(
    'INSERT INTO cotizacion_historial (cotizacion_id, tipo, detalle) VALUES ($1, $2, $3)',
    [cotizacionId, tipo, detalle]
  );
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
      // Un id existente identifica un ítem que ya estaba guardado (se
      // actualiza en su lugar, preservando su estado de aceptación); sin id
      // es un ítem nuevo agregado en esta edición.
      id: item.id !== undefined && item.id !== null && item.id !== '' ? Number(item.id) : null,
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

  return {
    titulo: String(input.titulo || '').trim() || null,
    observaciones: String(input.observaciones || '').trim() || null,
    validez,
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

function fmtMonto(n) {
  return `S/ ${Number(n).toFixed(2)}`;
}

// A diferencia del alta (que solo inserta), una edición tiene que preservar
// la identidad de los ítems que ya existían -junto con su estado de
// aceptación- porque aceptar/rechazar un ítem es independiente de guardar el
// formulario. Por eso se reconcilian por id en vez de borrar todo y volver a
// insertar: los que traen id se actualizan (o quedan igual si no cambió
// nada), los que no traen id son altas, y los que ya no vienen en la lista se
// borran. Cada cambio real queda como una línea de historial.
async function sincronizarItems(client, cotizacionId, itemsNuevos) {
  const { rows: existentes } = await client.query(
    `SELECT id, sku, nombre, cantidad, precio_unitario::float8 AS precio_unitario, tipo_precio, orden
     FROM cotizacion_items WHERE cotizacion_id = $1`,
    [cotizacionId]
  );
  const existentesPorId = new Map(existentes.map((r) => [r.id, r]));
  const idsConservados = new Set();

  for (const item of itemsNuevos) {
    const anterior = item.id !== null ? existentesPorId.get(item.id) : null;

    if (anterior) {
      idsConservados.add(item.id);
      const cambios = [];
      if (anterior.nombre !== item.nombre) cambios.push(`producto "${anterior.nombre}" → "${item.nombre}"`);
      if (anterior.cantidad !== item.cantidad) cambios.push(`cantidad ${anterior.cantidad} → ${item.cantidad}`);
      if (Number(anterior.precio_unitario) !== item.precioUnitario) {
        cambios.push(`precio ${fmtMonto(anterior.precio_unitario)} → ${fmtMonto(item.precioUnitario)}`);
      }

      if (cambios.length) {
        await client.query(
          `UPDATE cotizacion_items
           SET sku = $1, nombre = $2, cantidad = $3, precio_unitario = $4, tipo_precio = $5, orden = $6
           WHERE id = $7`,
          [item.sku, item.nombre, item.cantidad, item.precioUnitario, item.tipoPrecio, item.orden, item.id]
        );
        await registrarHistorial(client, cotizacionId, 'item_cambiado', `"${anterior.nombre}": ${cambios.join(', ')}`);
      } else if (anterior.orden !== item.orden) {
        await client.query('UPDATE cotizacion_items SET orden = $1 WHERE id = $2', [item.orden, item.id]);
      }
    } else {
      const { rows } = await client.query(
        `INSERT INTO cotizacion_items (cotizacion_id, sku, nombre, cantidad, precio_unitario, tipo_precio, orden)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [cotizacionId, item.sku, item.nombre, item.cantidad, item.precioUnitario, item.tipoPrecio, item.orden]
      );
      item.id = rows[0].id;
      await registrarHistorial(
        client,
        cotizacionId,
        'item_agregado',
        `Ítem agregado: "${item.nombre}" x${item.cantidad} a ${fmtMonto(item.precioUnitario)}`
      );
    }
  }

  for (const anterior of existentes) {
    if (!idsConservados.has(anterior.id)) {
      await client.query('DELETE FROM cotizacion_items WHERE id = $1', [anterior.id]);
      await registrarHistorial(client, cotizacionId, 'item_quitado', `Ítem quitado: "${anterior.nombre}"`);
    }
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
        `INSERT INTO cotizaciones (numero, documento, titulo, validez_dias, observaciones)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [numero, documento, cabecera.titulo, cabecera.validez, cabecera.observaciones]
      );
      await insertarItems(client, rows[0].id, items);
      await registrarHistorial(client, rows[0].id, 'creacion', `Cotización creada con ${items.length} ítem${items.length === 1 ? '' : 's'}`);
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

// Reconcilia los ítems en vez de reemplazarlos (ver sincronizarItems), para no
// perder el estado de aceptación de los que no cambiaron. Toca updated_at,
// con lo cual reinicia el semáforo.
async function updateCotizacion(id, input) {
  const cabecera = normalizarCabecera(input);
  const items = normalizarItems(input.items);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE cotizaciones
       SET titulo = $1, validez_dias = $2, observaciones = $3, updated_at = now()
       WHERE id = $4`,
      [cabecera.titulo, cabecera.validez, cabecera.observaciones, id]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    await sincronizarItems(client, id, items);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getCotizacion(id);
}

// Acepta/rechaza (o vuelve a pendiente) un ítem puntual, independiente del
// resto — así se puede aceptar un servicio hoy y dejar los otros en
// seguimiento. Toca updated_at igual que cualquier otra actividad.
async function setItemEstado(cotizacionId, itemId, estado) {
  if (!ITEM_ESTADOS.includes(estado)) throw new Error(`Estado inválido: ${estado}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT nombre, estado FROM cotizacion_items WHERE id = $1 AND cotizacion_id = $2',
      [itemId, cotizacionId]
    );
    const item = rows[0];
    if (!item) {
      await client.query('ROLLBACK');
      return null;
    }

    if (item.estado !== estado) {
      await client.query('UPDATE cotizacion_items SET estado = $1 WHERE id = $2', [estado, itemId]);
      await client.query('UPDATE cotizaciones SET updated_at = now() WHERE id = $1', [cotizacionId]);
      await registrarHistorial(client, cotizacionId, 'item_estado', `"${item.nombre}": ${ITEM_ESTADO_LABEL[estado]}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getCotizacion(cotizacionId);
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
  ITEM_ESTADOS,
  SEMAFOROS,
  listCotizaciones,
  getResumen,
  getCotizacion,
  createCotizacion,
  updateCotizacion,
  setItemEstado,
  addNota,
  registrarEnvio,
  deleteCotizacion,
};
