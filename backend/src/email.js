'use strict';

const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const config = require('./config');
const { query, one, many, getSetting } = require('./db');
const log = require('./logger');
const { escapeHtml } = require('./security');

const transport = nodemailer.createTransport({
  host: config.mail.host,
  port: config.mail.port,
  secure: config.mail.secure,
  auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  pool: true,
  maxConnections: 3,
  connectionTimeout: 10000,
  socketTimeout: 20000,
});

const ELIGIBLE_COLUMNS = new Set(['notify_launch', 'notify_updates']);
const BATCH_SIZE = 10;
const PAGE_SIZE = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unsubscribeUrl = (sub) => `${config.baseUrl}/api/unsubscribe?token=${sub.unsubscribe_token}`;

// Retries transient failures with exponential backoff and jitter.
// SMTP 5xx replies are permanent (for example, mailbox does not exist) and are not retried.
async function withRetry(task, { attempts = 4, baseMs = 500 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      const permanent = typeof err.responseCode === 'number' && err.responseCode >= 500;
      if (permanent || attempt >= attempts) throw err;
      await sleep(baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }
}

function buildCampaign(kind, subscriber, extra = {}) {
  const manage = unsubscribeUrl(subscriber);
  const footerText = `\n\n--\nManage or unsubscribe: ${manage}`;
  const footerHtml = '<hr><p style="font-size:12px;color:#666">You receive this because you subscribed. '
    + `<a href="${manage}">Manage or unsubscribe</a>.</p>`;
  if (kind === 'launch') {
    return {
      subject: 'We are live. Come take a look.',
      text: `The wait is over. Visit ${config.baseUrl}${footerText}`,
      html: `<p>The wait is over.</p><p><a href="${config.baseUrl}">Visit the site</a></p>${footerHtml}`,
    };
  }
  if (kind === 'date_update') {
    const when = new Date(extra.launchAt).toUTCString();
    return {
      subject: 'Our launch date has been updated',
      text: `Our launch date is now ${when}.${footerText}`,
      html: `<p>Our launch date is now <strong>${escapeHtml(when)}</strong>.</p>${footerHtml}`,
    };
  }
  throw new Error(`Unknown campaign kind: ${kind}`);
}

// The UNIQUE(subscriber_id, kind, campaign_key) constraint is the dedupe gate: the campaign is
// claimed before sending, so retries, double clicks and concurrent replicas cannot double-send.
// Returns 'sent' | 'failed' | 'duplicate'.
async function deliver({ subscriber, kind, campaignKey, message }) {
  const claim = await one(
    `INSERT INTO deliveries (subscriber_id, kind, campaign_key, status)
     VALUES ($1, $2, $3, 'queued') ON CONFLICT DO NOTHING RETURNING id`,
    [subscriber.id, kind, campaignKey],
  );
  if (!claim) return 'duplicate';

  let attempts = 0;
  try {
    const info = await withRetry(() => {
      attempts += 1;
      return transport.sendMail({
        from: config.mail.from,
        to: subscriber.email,
        ...message,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl(subscriber)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
    });
    await query(
      `UPDATE deliveries SET status = 'sent', attempts = $1, provider_id = $2, sent_at = now() WHERE id = $3`,
      [attempts, info.messageId ?? null, claim.id],
    );
    return 'sent';
  } catch (err) {
    await query(
      `UPDATE deliveries SET status = 'failed', attempts = $1, last_error = $2 WHERE id = $3`,
      [attempts, String(err.message).slice(0, 500), claim.id],
    );
    log.error('email_delivery_failed', { kind, subscriberId: String(subscriber.id), error: err.message });
    return 'failed';
  }
}

function sendConfirmation(subscriber, token) {
  const link = `${config.baseUrl}/api/confirm?token=${token}`;
  return deliver({
    subscriber,
    kind: 'confirmation',
    campaignKey: `confirm:${crypto.randomUUID()}`,
    message: {
      subject: 'Confirm your subscription',
      text: `Confirm your subscription:\n${link}\n\nThis link expires in 48 hours. If you did not sign up, ignore this email.`,
      html: `<p>Confirm your subscription:</p><p><a href="${link}">Confirm subscription</a></p>`
        + '<p>This link expires in 48 hours. If you did not sign up, ignore this email.</p>',
    },
  });
}

// Late subscribers still get the launch announcement if the site has already launched.
async function onActivated(subscriber) {
  if (subscriber.status !== 'active' || !subscriber.notify_launch) return 'skipped';
  if ((await getSetting('launched')) !== 'true') return 'skipped';
  return deliver({ subscriber, kind: 'launch', campaignKey: 'launch', message: buildCampaign('launch', subscriber) });
}

// Keyset-paginated so memory stays flat regardless of list size.
async function broadcast({ kind, campaignKey, eligibleColumn, extra = {} }) {
  if (!ELIGIBLE_COLUMNS.has(eligibleColumn)) throw new Error('Invalid eligibility column');
  const totals = { total: 0, sent: 0, failed: 0, duplicate: 0 };
  let lastId = '0';
  for (;;) {
    const page = await many(
      `SELECT * FROM subscribers
       WHERE status = 'active' AND ${eligibleColumn} = TRUE AND id > $1
       ORDER BY id LIMIT ${PAGE_SIZE}`,
      [lastId],
    );
    if (page.length === 0) break;
    lastId = page[page.length - 1].id;
    for (let i = 0; i < page.length; i += BATCH_SIZE) {
      const results = await Promise.all(page.slice(i, i + BATCH_SIZE).map((subscriber) =>
        deliver({ subscriber, kind, campaignKey, message: buildCampaign(kind, subscriber, extra) })));
      for (const result of results) totals[result] += 1;
      totals.total += results.length;
    }
  }
  log.info('broadcast_complete', { kind, campaignKey, ...totals });
  return totals;
}

module.exports = { sendConfirmation, onActivated, broadcast, withRetry, buildCampaign };
