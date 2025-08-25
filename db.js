// backend/db.js
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Missing DATABASE_URL in .env');

const needSSL =
  /render\.com|herokuapp\.com|amazonaws\.com/i.test(connectionString) ||
  process.env.PGSSLMODE === 'require';

const pool = new Pool({
  connectionString,
  ssl: needSSL ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('Unexpected PG client error', err);
  process.exit(1);
});

module.exports = pool;
