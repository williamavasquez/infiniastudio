const { pool } = require('./db');

function buildClientesFilter({ distrito, area, servicio, desde, hasta, q }, startIndex) {
  const conditions = [];
  const params = [];
  let i = startIndex;

  if (distrito) {
    conditions.push(`UPPER(c.distrito) = UPPER($${i++})`);
    params.push(distrito);
  }
  if (desde) {
    conditions.push(`c.fecha_creacion >= $${i++}`);
    params.push(desde);
  }
  if (hasta) {
    conditions.push(`c.fecha_creacion <= $${i++}`);
    params.push(`${hasta} 23:59:59`);
  }
  if (area) {
    conditions.push(`EXISTS (SELECT 1 FROM asistencias a WHERE a.nro_doc = c.documento AND a.area = $${i++})`);
    params.push(area);
  }
  if (servicio) {
    conditions.push(`EXISTS (SELECT 1 FROM asistencias a WHERE a.nro_doc = c.documento AND a.servicio ILIKE $${i++})`);
    params.push(`%${servicio}%`);
  }
  if (q) {
    conditions.push(
      `(c.documento ILIKE $${i} OR c.paciente ILIKE $${i} OR c.celular ILIKE $${i} OR c.correo ILIKE $${i})`
    );
    params.push(`%${q}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, nextIndex: i };
}

// Edad se calcula al vuelo desde f_nacimiento — nunca se guarda un valor fijo.
const EDAD_SELECT = `
  c.*,
  CASE WHEN c.f_nacimiento IS NOT NULL THEN EXTRACT(YEAR FROM AGE(c.f_nacimiento))::int END AS edad
`;

async function listClientes({ distrito, area, servicio, desde, hasta, q, offset = 0, limit = 100 }) {
  const { where, params, nextIndex } = buildClientesFilter({ distrito, area, servicio, desde, hasta, q }, 1);
  const limitParam = nextIndex;
  const offsetParam = nextIndex + 1;

  const sql = `
    SELECT ${EDAD_SELECT}
    FROM clientes c
    ${where}
    ORDER BY c.fecha_creacion DESC NULLS LAST, c.documento
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `;
  const { rows } = await pool.query(sql, [...params, limit + 1, offset]);

  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), hasMore };
}

async function listClientesAll({ distrito, area, servicio, desde, hasta, q }) {
  const { where, params } = buildClientesFilter({ distrito, area, servicio, desde, hasta, q }, 1);
  const sql = `
    SELECT ${EDAD_SELECT}
    FROM clientes c
    ${where}
    ORDER BY c.fecha_creacion DESC NULLS LAST, c.documento
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

function buildAsistenciasFilter({ distrito, area, servicio, desde, hasta, q }, startIndex) {
  const conditions = [];
  const params = [];
  let i = startIndex;

  if (distrito) {
    conditions.push(`UPPER(c.distrito) = UPPER($${i++})`);
    params.push(distrito);
  }
  if (area) {
    conditions.push(`a.area = $${i++}`);
    params.push(area);
  }
  if (servicio) {
    conditions.push(`a.servicio ILIKE $${i++}`);
    params.push(`%${servicio}%`);
  }
  if (desde) {
    conditions.push(`a.fecha >= $${i++}`);
    params.push(desde);
  }
  if (hasta) {
    conditions.push(`a.fecha <= $${i++}`);
    params.push(hasta);
  }
  if (q) {
    conditions.push(`(a.nro_doc ILIKE $${i} OR a.paciente ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, nextIndex: i };
}

async function listAsistencias({ distrito, area, servicio, desde, hasta, q, offset = 0, limit = 100 }) {
  const { where, params, nextIndex } = buildAsistenciasFilter({ distrito, area, servicio, desde, hasta, q }, 1);
  const limitParam = nextIndex;
  const offsetParam = nextIndex + 1;

  const sql = `
    SELECT a.*, c.distrito, c.apodo
    FROM asistencias a
    LEFT JOIN clientes c ON c.documento = a.nro_doc
    ${where}
    ORDER BY a.created_at DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `;
  const { rows } = await pool.query(sql, [...params, limit + 1, offset]);

  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), hasMore };
}

// Un mismo cliente puede venir el mismo día por más de un servicio (ej. Clase
// Grupal + Sesión INDIBA) — eso son 2 filas de asistencia, pero 1 sola
// persona y 1 sola visita. Por eso:
//   - clientesUnicos: cuenta DOCUMENTO distinto (personas distintas)
//   - asistencias: cuenta (documento, fecha) distinto (visitas — un mismo
//     cliente el mismo día cuenta 1 vez, sin importar cuántos servicios tomó)
//   - serviciosRealizados: cuenta cada fila (cada servicio elegido)
async function getResumenAsistencias({ distrito, area, servicio, desde, hasta, q }) {
  const { where, params } = buildAsistenciasFilter({ distrito, area, servicio, desde, hasta, q }, 1);

  const sql = `
    SELECT
      COUNT(DISTINCT a.nro_doc)::int AS clientes_unicos,
      COUNT(DISTINCT (a.nro_doc, a.fecha))::int AS asistencias,
      COUNT(*)::int AS servicios_realizados,
      COUNT(*) FILTER (WHERE a.area = 'Pilates')::int AS pilates,
      COUNT(*) FILTER (WHERE a.area = 'Estética')::int AS estetica
    FROM asistencias a
    LEFT JOIN clientes c ON c.documento = a.nro_doc
    ${where}
  `;
  const { rows } = await pool.query(sql, params);
  const r = rows[0];
  return {
    clientesUnicos: r.clientes_unicos,
    asistencias: r.asistencias,
    serviciosRealizados: r.servicios_realizados,
    pilates: r.pilates,
    estetica: r.estetica,
  };
}

async function getDashboard({ desde, hasta }) {
  const [{ rows: totalRows }, resumen, { rows: ultimosRows }] = await Promise.all([
    pool.query('SELECT count(*)::int AS total FROM clientes'),
    getResumenAsistencias({ desde, hasta }),
    pool.query(
      `SELECT documento, paciente, apodo, distrito, fecha_creacion
       FROM clientes
       WHERE fecha_creacion IS NOT NULL
       ORDER BY fecha_creacion DESC
       LIMIT 20`
    ),
  ]);

  return {
    totalClientes: totalRows[0].total,
    ...resumen,
    ultimosClientes: ultimosRows,
  };
}

module.exports = {
  getDashboard,
  getResumenAsistencias,
  listClientes,
  listClientesAll,
  listAsistencias,
};
