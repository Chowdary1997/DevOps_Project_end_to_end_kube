'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../../src/security');

test('normalizeEmail trims, lowercases and accepts valid addresses', () => {
  assert.equal(s.normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
});

test('normalizeEmail rejects malformed input', () => {
  const bad = ['', 'no-at-sign', 'a@b', 'two@@example.com', 'sp ace@example.com', null, 42, `${'x'.repeat(250)}@example.com`];
  for (const value of bad) assert.equal(s.normalizeEmail(value), null, `should reject ${String(value).slice(0, 30)}`);
});

test('isToken accepts only 64 lowercase hex characters', () => {
  assert.equal(s.isToken('a'.repeat(64)), true);
  assert.equal(s.isToken('A'.repeat(64)), false);
  assert.equal(s.isToken('a'.repeat(63)), false);
  assert.equal(s.isToken(['a'.repeat(64)]), false);
  assert.equal(s.isToken(undefined), false);
});

test('randomToken returns unique 64-character hex strings', () => {
  const tokens = new Set(Array.from({ length: 100 }, () => s.randomToken()));
  assert.equal(tokens.size, 100);
  for (const token of tokens) assert.equal(s.isToken(token), true);
});

test('sha256 is deterministic and does not expose its input', () => {
  assert.equal(s.sha256('abc'), s.sha256('abc'));
  assert.notEqual(s.sha256('abc'), s.sha256('abd'));
  assert.equal(s.sha256('secret').includes('secret'), false);
});

test('hashIp is keyed and never returns the raw address', () => {
  const hash = s.hashIp('203.0.113.7');
  assert.equal(hash, s.hashIp('203.0.113.7'));
  assert.notEqual(hash, s.hashIp('203.0.113.8'));
  assert.equal(hash.includes('203.0.113.7'), false);
});

test('safeEqual compares exact matches and rejects length mismatches', () => {
  assert.equal(s.safeEqual('token-value-1234', 'token-value-1234'), true);
  assert.equal(s.safeEqual('token-value-1234', 'token-value-1235'), false);
  assert.equal(s.safeEqual('short', 'much-longer-value'), false);
  assert.equal(s.safeEqual(undefined, 'x'), false);
});

test('escapeHtml neutralizes markup characters', () => {
  assert.equal(s.escapeHtml('<script>"x" & \'y\'</script>'),
    '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
});
