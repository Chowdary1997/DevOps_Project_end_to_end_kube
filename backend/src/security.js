'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const randomToken = () => crypto.randomBytes(32).toString('hex');
// Confirmation tokens are stored hashed, so a database leak cannot be used to confirm subscriptions.
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
// IPs are stored as keyed hashes: useful for abuse analysis, not reversible to an address.
const hashIp = (ip) => crypto.createHmac('sha256', config.ipHashSalt).update(String(ip ?? '')).digest('hex');
const isToken = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const normalizeEmail = (raw) => {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
};
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

module.exports = { randomToken, sha256, hashIp, isToken, normalizeEmail, safeEqual, escapeHtml };
