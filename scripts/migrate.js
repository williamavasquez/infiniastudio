require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../lib/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Esquema aplicado correctamente.');
  await pool.end();
})().catch((err) => {
  console.error('Error aplicando el esquema:', err);
  process.exit(1);
});
