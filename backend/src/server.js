'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const log = require('./logger');
const { query, one, withTransaction, migrate, getSetting, setSetting, close } = require('./db');
const { randomToken, sha256, hashIp, isToken, normalizeEmail, safeEqual, escapeHtml } = require('./security');
const { sendConfirmation, onActivated, broadcast } = require('./email');

const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;
const POLICY = config.policyVersion;

const app = express();
app.disable('x-powered-by');
if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

const limiter = (limit, windowMs, message) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: message } });
const subscribeLimiter = limiter(5, 15 * 60 * 1000, 'Too many attempts. Please try again later.');
const apiLimiter = limiter(300, 60 * 1000, 'Too many requests. Please slow down.');
const adminLimiter = limiter(30, 60 * 1000, 'Too many admin requests.');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Always called with a transaction client, so the consent row commits with the change it records.
async function recordConsent(client, subscriberId, action, req) {
  await client.query(
    `INSERT INTO consent_records (subscriber_id, action, policy_version, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [subscriberId, action, POLICY, hashIp(req.ip), String(req.get('user-agent') ?? '').slice(0, 300)],
  );
}

function page(res, status, title, body) {
  res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head>
<body class="notice"><main class="card"><h1>${escapeHtml(title)}</h1>${body}<p><a href="/">Back to home</a></p></main></body></html>`);
}

app.use('/api', (req, res, next) => (req.path === '/health' ? next() : apiLimiter(req, res, next)));

app.get('/api/health', wrap(async (req, res) => {
  await query('SELECT 1');
  res.json({ status: 'ok' });
}));

app.get('/api/config', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    launchAt: await getSetting('launch_at'),
    launched: (await getSetting('launched')) === 'true',
  });
}));

app.post('/api/subscribe', subscribeLimiter, wrap(async (req, res) => {
  const body = req.body ?? {};
  const message = config.doubleOptIn
    ? 'Almost there. Check your inbox to confirm your subscription.'
    : "You're on the list. Thanks for subscribing.";

  // Honeypot: bots fill hidden fields. Answer as if successful so bots get no signal.
  if (body.website) return res.status(202).json({ message });

  const email = normalizeEmail(body.email);
  if (!email) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (body.consent !== true) {
    return res.status(400).json({ error: 'Please accept the privacy notice to subscribe.' });
  }

  const notifyLaunch = typeof body.notifyLaunch === 'boolean' ? body.notifyLaunch : true;
  const notifyUpdates = typeof body.notifyUpdates === 'boolean' ? body.notifyUpdates : true;
  const existing = await one('SELECT id, status FROM subscribers WHERE email = $1', [email]);

  // Responses are identical whether or not the address exists, to prevent enumeration.
  if (existing?.status === 'bounced') {
    log.warn('subscribe_blocked_bounced');
    return res.status(202).json({ message });
  }
  if (existing?.status === 'active') {
    await withTransaction(async (client) => {
      await client.query(
        'UPDATE subscribers SET notify_launch = $1, notify_updates = $2, updated_at = now() WHERE id = $3',
        [notifyLaunch, notifyUpdates, existing.id],
      );
      await recordConsent(client, existing.id, 'preferences_update', req);
    });
    return res.status(202).json({ message });
  }

  const pending = config.doubleOptIn;
  const confirmToken = pending ? randomToken() : null;
  const subscriber = await withTransaction(async (client) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO subscribers (email, status, notify_launch, notify_updates, confirm_token_hash,
         confirm_expires_at, unsubscribe_token, source, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'website', $8)
       ON CONFLICT (email) DO UPDATE SET
         status = EXCLUDED.status, notify_launch = EXCLUDED.notify_launch,
         notify_updates = EXCLUDED.notify_updates, confirm_token_hash = EXCLUDED.confirm_token_hash,
         confirm_expires_at = EXCLUDED.confirm_expires_at, confirmed_at = EXCLUDED.confirmed_at,
         unsubscribed_at = NULL, updated_at = now()
       RETURNING *`,
      [
        email,
        pending ? 'pending' : 'active',
        notifyLaunch,
        notifyUpdates,
        confirmToken ? sha256(confirmToken) : null,
        pending ? new Date(Date.now() + CONFIRM_TTL_MS) : null,
        randomToken(),
        pending ? null : new Date(),
      ],
    );
    await recordConsent(client, row.id, 'subscribe', req);
    return row;
  });

  const job = pending ? sendConfirmation(subscriber, confirmToken) : onActivated(subscriber);
  job.catch((err) => log.error('post_subscribe_job_failed', { error: err.message }));
  res.status(202).json({ message });
}));

app.get('/api/confirm', wrap(async (req, res) => {
  const token = req.query.token;
  if (!isToken(token)) return page(res, 400, 'Invalid link', '<p>This confirmation link is invalid.</p>');

  // Single atomic UPDATE: a link can only be consumed once, even under concurrent clicks.
  const active = await withTransaction(async (client) => {
    const { rows: [row] } = await client.query(
      `UPDATE subscribers SET status = 'active', confirmed_at = now(), confirm_token_hash = NULL,
         confirm_expires_at = NULL, updated_at = now()
       WHERE confirm_token_hash = $1 AND status = 'pending' AND confirm_expires_at > now()
       RETURNING *`,
      [sha256(token)],
    );
    if (!row) return null;
    await recordConsent(client, row.id, 'confirm', req);
    return row;
  });
  if (!active) {
    return page(res, 400, 'Link expired', '<p>This link is invalid or has expired. Please subscribe again.</p>');
  }
  onActivated(active).catch((err) => log.error('launch_send_failed', { error: err.message }));
  page(res, 200, "You're subscribed", '<p>Thanks for confirming. We will be in touch.</p>');
}));

app.get('/api/unsubscribe', wrap(async (req, res) => {
  const token = req.query.token;
  const sub = isToken(token)
    ? await one(`SELECT notify_launch, notify_updates FROM subscribers
        WHERE unsubscribe_token = $1 AND status IN ('pending', 'active')`, [token])
    : null;
  if (!sub) return page(res, 400, 'Invalid link', '<p>This link is invalid or no longer active.</p>');
  page(res, 200, 'Manage your emails', `
    <form method="post" action="/api/preferences" class="stack">
      <input type="hidden" name="token" value="${token}">
      <fieldset class="prefs">
        <legend>Send me</legend>
        <label><input type="checkbox" name="notifyLaunch"${sub.notify_launch ? ' checked' : ''}> Launch day announcement</label>
        <label><input type="checkbox" name="notifyUpdates"${sub.notify_updates ? ' checked' : ''}> Launch date changes</label>
      </fieldset>
      <button type="submit">Save preferences</button>
    </form>
    <form method="post" action="/api/unsubscribe?token=${token}" class="stack">
      <button type="submit" class="secondary">Unsubscribe from all emails</button>
    </form>`);
}));

// Handles the manage-page unsubscribe form and RFC 8058 one-click unsubscribe from mail clients.
app.post('/api/unsubscribe', wrap(async (req, res) => {
  const token = req.query.token ?? req.body?.token;
  if (!isToken(token)) return page(res, 400, 'Invalid link', '<p>This unsubscribe link is invalid.</p>');
  await withTransaction(async (client) => {
    const { rows: [row] } = await client.query(
      `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
       WHERE unsubscribe_token = $1 RETURNING id`,
      [token],
    );
    if (row) await recordConsent(client, row.id, 'unsubscribe', req);
  });
  // Same response whether or not the token exists.
  page(res, 200, 'You are unsubscribed', '<p>You will no longer receive emails from us.</p>');
}));

app.post('/api/preferences', wrap(async (req, res) => {
  const token = req.body?.token;
  if (!isToken(token)) return page(res, 400, 'Invalid link', '<p>This link is invalid.</p>');
  const updated = await withTransaction(async (client) => {
    const { rows: [row] } = await client.query(
      `UPDATE subscribers SET notify_launch = $1, notify_updates = $2, updated_at = now()
       WHERE unsubscribe_token = $3 AND status IN ('pending', 'active') RETURNING id`,
      [req.body.notifyLaunch === 'on', req.body.notifyUpdates === 'on', token],
    );
    if (row) await recordConsent(client, row.id, 'preferences_update', req);
    return Boolean(row);
  });
  if (!updated) return page(res, 404, 'Not found', '<p>This subscription is no longer active.</p>');
  page(res, 200, 'Preferences saved', '<p>Your email preferences have been updated.</p>');
}));

// Bounce and complaint events from the email provider. Map the provider's native payload
// (SES SNS, Postmark, SendGrid) to { type: 'bounce' | 'complaint', email } in a small adapter.
app.post('/api/webhooks/email-events', wrap(async (req, res) => {
  if (!safeEqual(req.get('x-webhook-secret'), config.webhookSecret)) return res.sendStatus(401);
  const email = normalizeEmail(req.body?.email);
  const type = req.body?.type;
  if (!email || !['bounce', 'complaint'].includes(type)) return res.sendStatus(400);
  const status = type === 'complaint' ? 'unsubscribed' : 'bounced';
  const result = await query('UPDATE subscribers SET status = $1, updated_at = now() WHERE email = $2', [status, email]);
  log.warn('email_event', { type, matched: result.rowCount > 0 });
  res.sendStatus(204);
}));

const requireAdmin = (req, res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(token, config.adminToken)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
app.use('/api/admin', adminLimiter, requireAdmin);

app.put('/api/admin/launch-date', wrap(async (req, res) => {
  const timestamp = Date.parse(req.body?.launchAt);
  if (Number.isNaN(timestamp)) return res.status(400).json({ error: 'launchAt must be an ISO 8601 date-time.' });
  const iso = new Date(timestamp).toISOString();
  const previous = await getSetting('launch_at');
  await setSetting('launch_at', iso);
  const changed = previous !== iso;
  if (changed) {
    broadcast({ kind: 'date_update', campaignKey: `date:${iso}`, eligibleColumn: 'notify_updates', extra: { launchAt: iso } })
      .catch((err) => log.error('broadcast_failed', { error: err.message }));
  }
  res.status(202).json({ launchAt: iso, notifications: changed ? 'queued' : 'none' });
}));

app.post('/api/admin/launch', wrap(async (req, res) => {
  if ((await getSetting('launched')) === 'true') return res.status(409).json({ error: 'Already launched.' });
  await setSetting('launched', 'true');
  broadcast({ kind: 'launch', campaignKey: 'launch', eligibleColumn: 'notify_launch' })
    .catch((err) => log.error('broadcast_failed', { error: err.message }));
  res.status(202).json({ notifications: 'queued' });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status === 400 || err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large.' });
  log.error('unhandled_error', { path: req.path, error: err.message });
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: 'Internal server error.' });
});

// Retries while the database container finishes starting.
async function migrateWithRetry(maxAttempts = 10) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await migrate();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      log.warn('database_unavailable', { attempt, error: err.message });
      await sleep(2000 * attempt);
    }
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start() {
  await migrateWithRetry();
  if (config.launchAt) {
    await query(`INSERT INTO settings (key, value) VALUES ('launch_at', $1) ON CONFLICT (key) DO NOTHING`, [config.launchAt]);
  }
  const server = app.listen(config.port, () => log.info('server_started', { port: config.port, env: config.env }));
  const shutdown = (signal) => {
    log.info('shutdown', { signal });
    server.close(() => close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((err) => {
    log.error('startup_failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = app;
