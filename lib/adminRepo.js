const { pool } = require('./db');

async function getDashboard() {
  const [{ rows: totalRows }, { rows: diaRows }, { rows: semanaRows }, { rows: ultimosRows }] = await Promise.all([
    pool.query('SELECT count(*)::int AS total FROM clientes'),
    pool.query("SELECT count(*)::int AS total FROM asistencias WHERE created_at >= now() - interval '1 day'"),
    pool.query("SELECT count(*)::int AS total FROM asistencias WHERE created_at >= now() - interval '7 days'"),
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
    checkinsUltimoDia: diaRows[0].total,
    checkinsUltimaSemana: semanaRows[0].total,
    ultimosClientes: ultimosRows,
  };
}

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
    conditions.push(`(c.documento ILIKE $${i} OR c.paciente ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params, nextIndex: i };
}

async function listClientes({ distrito, area, servicio, desde, hasta, q, offset = 0, limit = 100 }) {
  const { where, params, nextIndex } = buildClientesFilter({ distrito, area, servicio, desde, hasta, q }, 1);
  const limitParam = nextIndex;
  const offsetParam = nextIndex + 1;

  const sql = `
    SELECT c.*
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
    SELECT c.*
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

module.exports = {
  getDashboard,
  listClientes,
  listClientesAll,
  listAsistencias,
};
