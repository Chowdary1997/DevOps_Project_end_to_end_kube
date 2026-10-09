'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const config = require('./config');
const log = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_LOCK_ID = 7281937;

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (err) => log.error('pg_pool_error', { error: err.message }));

const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;
const many = async (text, params) => (await pool.query(text, params)).rows;

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Forward-only migrations from migrations/NNN_name.sql. A Postgres advisory lock means
// concurrent startups (multiple replicas) are safe: one applies DDL, the others wait.
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (applied.rowCount > 0) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info('migration_applied', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

const getSetting = async (key) =>
  (await one('SELECT value FROM settings WHERE key = $1', [key]))?.value ?? null;
const setSetting = (key, value) => query(
  `INSERT INTO settings (key, value) VALUES ($1, $2)
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  [key, value],
);

const close = () => pool.end();

module.exports = { pool, query, one, many, withTransaction, migrate, getSetting, setSetting, close };

if (require.main === module) {
  migrate()
    .then(() => console.log('Migrations applied.'))
    .then(close)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
