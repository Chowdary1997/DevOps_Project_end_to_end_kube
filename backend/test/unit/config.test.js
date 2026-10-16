'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const VALID = {
  PUBLIC_BASE_URL: 'http://localhost:8080',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  IP_HASH_SALT: 'a'.repeat(40),
  ADMIN_TOKEN: 'b'.repeat(40),
  WEBHOOK_SECRET: 'c'.repeat(40),
  SMTP_HOST: 'localhost',
  MAIL_FROM: 'Test <test@example.test>',
};

// Config reads the environment at require time, so each case runs in a fresh process
// with only the variables it sets (no inherited .env.test values).
function loadConfig(env, script = "console.log(JSON.stringify(require('./src/config')))") {
  return spawnSync(process.execPath, ['-e', script], { cwd: BACKEND_ROOT, env, encoding: 'utf8' });
}

test('config fails fast when a required variable is missing', () => {
  const result = loadConfig({});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required environment variable: PUBLIC_BASE_URL/);
});

test('config rejects secrets shorter than 32 characters', () => {
  const result = loadConfig({ ...VALID, IP_HASH_SALT: 'short' });
  assert.match(result.stderr, /IP_HASH_SALT must be at least 32 characters/);
});

test('TRUST_PROXY accepts a numeric hop count', () => {
  const result = loadConfig({ ...VALID, TRUST_PROXY: '2' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).trustProxy, 2);
});

test('double opt-in is enabled by default', () => {
  const result = loadConfig(VALID);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).doubleOptIn, true);
});
