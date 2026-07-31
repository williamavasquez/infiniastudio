const { pool } = require('./db');

function normalizeDocumento(v) {
  return String(v || '').trim();
}

async function lookupByDocumento(documento) {
  const target = normalizeDocumento(documento);
  if (!target) return null;
  const { rows } = await pool.query('SELECT * FROM clientes WHERE documento = $1', [target]);
  return rows[0] || null;
}

// Upsert by documento. fecha_creacion is only set on first insert — the
// ON CONFLICT clause deliberately omits it, so Postgres keeps the original
// value on every subsequent edit.
async function saveCliente(input) {
  const documento = normalizeDocumento(input.DOCUMENTO);
  if (!documento) throw new Error('DOCUMENTO es requerido');

  const { rows } = await pool.query(
    `INSERT INTO clientes (documento, tipo_doc, paciente, apodo, ruc, celular, distrito, f_nacimiento, sexo, correo, direccion, fecha_creacion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (documento) DO UPDATE SET
       tipo_doc = EXCLUDED.tipo_doc,
       paciente = EXCLUDED.paciente,
       apodo = EXCLUDED.apodo,
       ruc = EXCLUDED.ruc,
       celular = EXCLUDED.celular,
       distrito = EXCLUDED.distrito,
       f_nacimiento = EXCLUDED.f_nacimiento,
       sexo = EXCLUDED.sexo,
       correo = EXCLUDED.correo,
       direccion = EXCLUDED.direccion
     RETURNING *`,
    [
      documento,
      input.TIPO_DOC || null,
      input.PACIENTE,
      input.APODO || null,
      input.RUC || null,
      input.CELULAR || null,
      input.DISTRITO || null,
      input.F_NACIMIENTO || null,
      input.SEXO || null,
      input.CORREO || null,
      input.DIRECCION || null,
    ]
  );
  return rows[0];
}

module.exports = { lookupByDocumento, saveCliente };
