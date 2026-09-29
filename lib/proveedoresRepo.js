const { pool } = require('./db');

const PROVEEDOR_SELECT = 'id, nombre, ruc, contacto, telefono, correo, activo';

function normalizar(input) {
  const nombre = String(input.nombre || '').trim();
  if (!nombre) throw new Error('El nombre del proveedor es requerido');
  const opcional = (v) => String(v || '').trim() || null;
  return {
    nombre,
    ruc: opcional(input.ruc),
    contacto: opcional(input.contacto),
    telefono: opcional(input.telefono),
    correo: opcional(input.correo),
    activo: input.activo === undefined ? true : Boolean(input.activo),
  };
}

async function listProveedores() {
  const { rows } = await pool.query(`SELECT ${PROVEEDOR_SELECT} FROM proveedores ORDER BY activo DESC, nombre`);
  return rows;
}

async function createProveedor(input) {
  const p = normalizar(input);
  const { rows } = await pool.query(
    `INSERT INTO proveedores (nombre, ruc, contacto, telefono, correo, activo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PROVEEDOR_SELECT}`,
    [p.nombre, p.ruc, p.contacto, p.telefono, p.correo, p.activo]
  );
  return rows[0];
}

async function updateProveedor(id, input) {
  const p = normalizar(input);
  const { rows } = await pool.query(
    `UPDATE proveedores SET nombre = $2, ruc = $3, contacto = $4, telefono = $5, correo = $6, activo = $7
     WHERE id = $1 RETURNING ${PROVEEDOR_SELECT}`,
    [id, p.nombre, p.ruc, p.contacto, p.telefono, p.correo, p.activo]
  );
  return rows[0] || null;
}

// Un proveedor con productos o compras asociados no se borra (la FK lo
// impide): se desactiva.
async function deleteProveedor(id) {
  try {
    const { rowCount } = await pool.query('DELETE FROM proveedores WHERE id = $1', [id]);
    return rowCount > 0;
  } catch (err) {
    if (err.code === '23503') throw new Error('El proveedor tiene productos o compras asociados: desactivalo en vez de borrarlo');
    throw err;
  }
}

module.exports = { listProveedores, createProveedor, updateProveedor, deleteProveedor };
