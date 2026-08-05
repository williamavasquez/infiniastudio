const { pool } = require('./db');
const { peruNow } = require('./peruTime');
const { lookupByDocumento } = require('./clientesRepo');

const AREAS = ['Pilates', 'Estética'];

// Servicios sugeridos por área — "Otros" acepta cualquier texto libre, no
// está restringido a esta lista.
const SERVICIOS_POR_AREA = {
  Pilates: ['Clase Grupal', 'Clase Personalizada', 'Clase Teens', 'Clase Senior'],
  Estética: ['Consulta Estética', 'Sesión INDIBA', 'Sesión Onda Coolwaves', 'Sesión Emerald'],
};

// Áreas ya asistidas hoy (hora Perú) por este documento — un cliente no
// puede repetir área el mismo día, pero sí al día siguiente.
async function getAreasHoy(nroDocumento) {
  const documento = String(nroDocumento || '').trim();
  if (!documento) return [];
  const { fecha } = peruNow();
  const { rows } = await pool.query(
    'SELECT DISTINCT area FROM asistencias WHERE nro_doc = $1 AND fecha = $2 AND area IS NOT NULL',
    [documento, fecha]
  );
  return rows.map((r) => r.area);
}

async function createAsistencia({ nroDocumento, area, servicio }) {
  if (!AREAS.includes(area)) {
    throw new Error(`AREA debe ser una de: ${AREAS.join(', ')}`);
  }
  const servicioTrim = String(servicio || '').trim();
  if (!servicioTrim) {
    throw new Error('SERVICIO es requerido');
  }

  const cliente = await lookupByDocumento(nroDocumento);
  if (!cliente) {
    throw new Error('No se encontró un cliente con ese documento. Registralo antes de marcar asistencia.');
  }

  const { fecha, hora, turno } = peruNow();

  // El límite de una vez por área por día solo aplica a los servicios fijos
  // del menú — "Otros" es texto libre y puede ser un servicio distinto no
  // cubierto por esa lista, así que no cuenta como repetido.
  const esServicioEstandar = (SERVICIOS_POR_AREA[area] || []).includes(servicioTrim);
  if (esServicioEstandar) {
    const areasHoy = await getAreasHoy(nroDocumento);
    if (areasHoy.includes(area)) {
      throw new Error(`Ya registraste una asistencia de ${area} hoy. Podés volver a registrarte mañana.`);
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO asistencias (fecha, hora_atencion, turno, tipo_doc, nro_doc, paciente, area, servicio)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [fecha, hora, turno, cliente.tipo_doc, cliente.documento, cliente.paciente, area, servicioTrim]
  );
  return rows[0];
}

async function deleteById(id) {
  const { rowCount } = await pool.query('DELETE FROM asistencias WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { createAsistencia, deleteById, getAreasHoy, AREAS, SERVICIOS_POR_AREA };
