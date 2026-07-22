const { pool } = require('./db');
const { peruNow } = require('./peruTime');
const { lookupByDocumento } = require('./clientesRepo');

const CATEGORIAS = ['Asistencia Estética', 'Asistencia Pilates', 'Clase de prueba', 'Consulta Medica'];

async function createAsistencia({ nroDocumento, categoria }) {
  if (!CATEGORIAS.includes(categoria)) {
    throw new Error(`CATEGORIA debe ser una de: ${CATEGORIAS.join(', ')}`);
  }

  const cliente = await lookupByDocumento(nroDocumento);
  if (!cliente) {
    throw new Error('No se encontró un cliente con ese documento. Registralo antes de marcar asistencia.');
  }

  const { fecha, hora, turno } = peruNow();

  const { rows } = await pool.query(
    `INSERT INTO asistencias (fecha, hora_atencion, turno, tipo_doc, nro_doc, paciente, categoria)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [fecha, hora, turno, cliente.tipo_doc, cliente.documento, cliente.paciente, categoria]
  );
  return rows[0];
}

module.exports = { createAsistencia, CATEGORIAS };
