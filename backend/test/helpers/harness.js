'use strict';
// Shared harness for API and regression tests. Uses the real app, real PostgreSQL,
// and a real SMTP sink (Mailpit) whose HTTP API lets tests read the emails sent.
const crypto = require('node:crypto');
const { once } = require('node:events');
const app = require('../../src/server');
const { migrate, query, close } = require('../../src/db');

const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server;
let base;

async function startServer() {
  await migrate();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await close();
}

// Each request gets its own client IP through X-Forwarded-For (TRUST_PROXY=1), so rate limits
// do not leak between tests. Regression tests pass an explicit ip to test the limiter.
const randomIp = () => `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;

async function api(method, path, { body, raw, headers = {}, ip } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip ?? randomIp(), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function resetState() {
  await query('TRUNCATE consent_records, deliveries, subscribers RESTART IDENTITY CASCADE');
  await query("UPDATE settings SET value = 'false' WHERE key = 'launched'");
}

async function resetMail() {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
}

async function mailsFor(to, subject) {
  const { messages = [] } = await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json();
  const matches = messages
    .filter((m) => m.To.some((t) => t.Address === to) && (!subject || m.Subject.includes(subject)))
    .sort((a, b) => new Date(a.Created) - new Date(b.Created));
  const full = [];
  for (const m of matches) full.push(await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json());
  return full;
}

async function waitForMails(to, count, { subject, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mails = await mailsFor(to, subject);
    if (mails.length >= count) return mails;
    if (Date.now() > deadline) throw new Error(`Expected ${count} mail(s) to ${to}, found ${mails.length}`);
    await sleep(250);
  }
}

const tokenFrom = (text) => {
  const match = text.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error('No token found in email');
  return match[1];
};

const uniqueEmail = (tag = 'user') => `${tag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const subscriberRow = async (email) => (await query('SELECT * FROM subscribers WHERE email = $1', [email])).rows[0] ?? null;
const consentActions = async (email) =>
  (await query(`SELECT c.action FROM consent_records c JOIN subscribers s ON s.id = c.subscriber_id WHERE s.email = $1`, [email]))
    .rows.map((r) => r.action);

// Creates a confirmed subscriber through the public API, the same way a real user would.
async function activeSubscriber(extra = {}) {
  const email = uniqueEmail();
  const res = await api('POST', '/api/subscribe', { body: { email, consent: true, ...extra } });
  if (res.status !== 202) throw new Error(`subscribe failed with ${res.status}`);
  const [mail] = await waitForMails(email, 1, { subject: 'Confirm' });
  const confirmed = await api('GET', `/api/confirm?token=${tokenFrom(mail.Text)}`);
  if (confirmed.status !== 200) throw new Error(`confirm failed with ${confirmed.status}`);
  return email;
}

module.exports = {
  startServer, stopServer, api, resetState, resetMail, mailsFor, waitForMails,
  tokenFrom, uniqueEmail, subscriberRow, consentActions, activeSubscriber, sleep,
  adminAuth: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
};
