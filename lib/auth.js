const crypto = require('crypto');
const usuariosRepo = require('./usuariosRepo');

const SESSION_SECRET = process.env.SESSION_SECRET || 'infinia-admin-dev-secret-change-me';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE_NAME = 'admin_session';

// Módulos que existen como permiso independiente en el panel admin.
const MODULOS = ['clientes', 'asistencias', 'productos', 'cotizaciones', 'cuentas'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sign(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function setSessionCookie(req, res, userId) {
  const token = sign({ uid: userId, exp: Date.now() + SESSION_TTL_MS });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Carga al usuario autenticado (con su rol/permisos) en req.user, o null si
// no hay sesión válida / la cuenta fue desactivada mientras tanto.
async function loadUser(req) {
  const cookies = parseCookies(req);
  const payload = verify(cookies[COOKIE_NAME]);
  if (!payload) return null;
  const user = await usuariosRepo.getUsuarioConRol(payload.uid);
  if (!user || !user.activo) return null;
  return user;
}

async function requireAuth(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// El rol Admin (es_admin=true) siempre pasa, sin importar el mapa de permisos.
function requirePermission(modulo) {
  return async (req, res, next) => {
    try {
      const user = req.user || (await loadUser(req));
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      req.user = user;
      if (user.es_admin || user.permisos[modulo]) return next();
      res.status(403).json({ error: 'No tenés permiso para esta sección' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = {
  MODULOS,
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  loadUser,
  requireAuth,
  requirePermission,
};
