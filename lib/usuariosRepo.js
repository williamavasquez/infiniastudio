const { pool } = require('./db');

const MODULOS = ['clientes', 'asistencias', 'productos', 'cotizaciones', 'cuentas'];
// Niveles de precio del tarifario que un rol puede ver/elegir al agregar un
// ítem a una cotización. "max_desc" queda aparte porque en la práctica es un
// precio que solo se usa con aprobación previa.
const PRECIO_TIERS = ['regular', 'oferta', 'max_desc'];

function normalizarPermisos(input) {
  const permisos = {};
  for (const m of MODULOS) permisos[m] = Boolean(input && input[m]);
  const precios = {};
  for (const t of PRECIO_TIERS) precios[t] = Boolean(input && input.precios && input.precios[t]);
  permisos.precios = precios;
  return permisos;
}

const ROL_SELECT = `id, nombre, es_admin, permisos, created_at, updated_at`;

async function listRoles() {
  const { rows } = await pool.query(`SELECT ${ROL_SELECT} FROM roles ORDER BY es_admin DESC, nombre`);
  return rows;
}

async function getRol(id) {
  const { rows } = await pool.query(`SELECT ${ROL_SELECT} FROM roles WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function createRol({ nombre, permisos }) {
  const nombreTrim = String(nombre || '').trim();
  if (!nombreTrim) throw new Error('El nombre del rol es requerido');
  const { rows } = await pool.query(
    `INSERT INTO roles (nombre, es_admin, permisos) VALUES ($1, false, $2) RETURNING ${ROL_SELECT}`,
    [nombreTrim, JSON.stringify(normalizarPermisos(permisos))]
  );
  return rows[0];
}

// El rol Admin (es_admin) no se puede renombrar ni tocarle los permisos: es
// el "dios" que garantiza que siempre haya alguien con acceso a todo.
async function updateRol(id, { nombre, permisos }) {
  const rol = await getRol(id);
  if (!rol) return null;
  if (rol.es_admin) throw new Error('El rol Admin no se puede editar');
  const nombreTrim = String(nombre || '').trim();
  if (!nombreTrim) throw new Error('El nombre del rol es requerido');
  const { rows } = await pool.query(
    `UPDATE roles SET nombre = $2, permisos = $3, updated_at = now() WHERE id = $1 RETURNING ${ROL_SELECT}`,
    [id, nombreTrim, JSON.stringify(normalizarPermisos(permisos))]
  );
  return rows[0];
}

async function deleteRol(id) {
  const rol = await getRol(id);
  if (!rol) return false;
  if (rol.es_admin) throw new Error('El rol Admin no se puede borrar');
  const { rows: enUso } = await pool.query('SELECT 1 FROM usuarios WHERE rol_id = $1 LIMIT 1', [id]);
  if (enUso.length) throw new Error('No se puede borrar un rol con cuentas asignadas');
  await pool.query('DELETE FROM roles WHERE id = $1', [id]);
  return true;
}

const USUARIO_SELECT = `
  u.id, u.username, u.activo, u.rol_id, u.created_at, u.updated_at,
  r.nombre AS rol_nombre, r.es_admin, r.permisos
`;

function mapUsuario(row) {
  if (!row) return null;
  const { password_hash, ...resto } = row;
  return resto;
}

async function listUsuarios() {
  const { rows } = await pool.query(
    `SELECT ${USUARIO_SELECT} FROM usuarios u JOIN roles r ON r.id = u.rol_id ORDER BY u.username`
  );
  return rows;
}

// Para login: incluye password_hash, que nunca sale de este módulo.
async function getUsuarioPorUsername(username) {
  const { rows } = await pool.query(
    `SELECT u.*, r.nombre AS rol_nombre, r.es_admin, r.permisos
     FROM usuarios u JOIN roles r ON r.id = u.rol_id
     WHERE lower(u.username) = lower($1)`,
    [username]
  );
  return rows[0] || null;
}

// Para middleware de auth: usuario + rol, sin password_hash.
async function getUsuarioConRol(id) {
  const { rows } = await pool.query(
    `SELECT ${USUARIO_SELECT} FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1`,
    [id]
  );
  return mapUsuario(rows[0]);
}

async function createUsuario({ username, passwordHash, rolId }) {
  const usernameTrim = String(username || '').trim();
  if (!usernameTrim) throw new Error('El usuario es requerido');
  if (!rolId) throw new Error('El rol es requerido');
  const { rows } = await pool.query(
    `INSERT INTO usuarios (username, password_hash, rol_id) VALUES ($1, $2, $3) RETURNING id`,
    [usernameTrim, passwordHash, rolId]
  );
  return getUsuarioConRol(rows[0].id);
}

async function updateUsuario(id, { rolId, activo, passwordHash }) {
  const sets = [];
  const params = [id];
  let i = 2;
  if (rolId !== undefined) {
    sets.push(`rol_id = $${i++}`);
    params.push(rolId);
  }
  if (activo !== undefined) {
    sets.push(`activo = $${i++}`);
    params.push(Boolean(activo));
  }
  if (passwordHash !== undefined) {
    sets.push(`password_hash = $${i++}`);
    params.push(passwordHash);
  }
  if (!sets.length) return getUsuarioConRol(id);
  sets.push('updated_at = now()');
  const { rows } = await pool.query(`UPDATE usuarios SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
  if (!rows[0]) return null;
  return getUsuarioConRol(id);
}

async function deleteUsuario(id) {
  const { rows } = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

async function contarUsuarios() {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM usuarios');
  return rows[0].total;
}

// Si todavía no hay ninguna cuenta, crea la primera cuenta Admin a partir de
// ADMIN_USERNAME/ADMIN_PASSWORD (o el password compartido histórico), para
// que el acceso existente no se rompa al pasar a cuentas individuales.
async function bootstrapAdmin(hashPassword) {
  const total = await contarUsuarios();
  if (total > 0) return;
  const { rows: adminRol } = await pool.query('SELECT id FROM roles WHERE es_admin = true LIMIT 1');
  if (!adminRol[0]) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || '0331';
  await pool.query('INSERT INTO usuarios (username, password_hash, rol_id) VALUES ($1, $2, $3)', [
    username,
    hashPassword(password),
    adminRol[0].id,
  ]);
  console.log(`Cuenta Admin creada: usuario "${username}" (contraseña desde ADMIN_PASSWORD).`);
}

module.exports = {
  MODULOS,
  PRECIO_TIERS,
  listRoles,
  getRol,
  createRol,
  updateRol,
  deleteRol,
  listUsuarios,
  getUsuarioPorUsername,
  getUsuarioConRol,
  createUsuario,
  updateUsuario,
  deleteUsuario,
  bootstrapAdmin,
};
