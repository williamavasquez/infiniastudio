const { Pool, types } = require('pg');

// Return DATE columns as plain "YYYY-MM-DD" strings instead of JS Date
// objects — we only ever store/compare ISO date strings, and a Date object
// would serialize to a full timestamp in JSON and break <input type="date">.
types.setTypeParser(1082, (val) => val);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no está definido. Configurá la variable de entorno antes de arrancar.');
}

// Local Postgres has no SSL. Railway's Postgres requires it. Opt in
// explicitly rather than guessing from NODE_ENV.
const useSSL = process.env.PGSSLMODE === 'require';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
