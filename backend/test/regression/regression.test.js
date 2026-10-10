'use strict';
// Regression suite: each test pins a behaviour that broke or could break, so it cannot silently return.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/harness');
const { broadcast } = require('../../src/email');

before(() => h.startServer());
after(() => h.stopServer());
beforeEach(async () => {
  await h.resetState();
  await h.resetMail();
});

describe('regressions', () => {
  it('REG-001 health checks are not rate limited, so probes never fail under load', async () => {
    const ip = '198.51.100.1';
    for (let i = 0; i < 320; i += 1) {
      const res = await h.api('GET', '/api/health', { ip });
      assert.equal(res.status, 200, `health check ${i} returned ${res.status}`);
    }
  });

  it('REG-002 subscribe attempts are rate limited per client IP', async () => {
    const ip = '198.51.100.2';
    for (let i = 0; i < 5; i += 1) {
      const res = await h.api('POST', '/api/subscribe', { body: { email: h.uniqueEmail(), consent: true }, ip });
      assert.equal(res.status, 202);
    }
    const blocked = await h.api('POST', '/api/subscribe', { body: { email: h.uniqueEmail(), consent: true }, ip });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Too many attempts/);
  });

  it('REG-003 rate limits are independent per client (proxy-aware client IP)', async () => {
    for (let i = 0; i < 6; i += 1) {
      await h.api('POST', '/api/subscribe', { body: { email: h.uniqueEmail(), consent: true }, ip: '198.51.100.3' });
    }
    const other = await h.api('POST', '/api/subscribe', { body: { email: h.uniqueEmail(), consent: true }, ip: '198.51.100.4' });
    assert.equal(other.status, 202);
  });

  it('REG-004 existing and new addresses get identical responses (no account enumeration)', async () => {
    const email = h.uniqueEmail();
    const fresh = await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    const repeat = await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    assert.equal(fresh.status, repeat.status);
    assert.equal(fresh.body.message, repeat.body.message);
  });

  it('REG-005 a GET on the unsubscribe link does not unsubscribe (safe against link scanners)', async () => {
    const email = await h.activeSubscriber();
    const { unsubscribe_token: token } = await h.subscriberRow(email);
    const res = await h.api('GET', `/api/unsubscribe?token=${token}`);
    assert.equal(res.status, 200);
    assert.equal((await h.subscriberRow(email)).status, 'active');
  });

  it('REG-006 a confirmation link can be consumed by exactly one of many concurrent clicks', async () => {
    const email = h.uniqueEmail();
    await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    const [mail] = await h.waitForMails(email, 1, { subject: 'Confirm' });
    const url = `/api/confirm?token=${h.tokenFrom(mail.Text)}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => h.api('GET', url)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
  });

  it('REG-007 a campaign is never delivered twice to the same subscriber', async () => {
    const email = await h.activeSubscriber({ notifyLaunch: true });
    const campaign = { kind: 'launch', campaignKey: 'reg-007', eligibleColumn: 'notify_launch' };
    const first = await broadcast(campaign);
    const second = await broadcast(campaign);
    assert.equal(first.sent, 1);
    assert.equal(second.sent, 0);
    assert.equal(second.duplicate, 1);
    assert.equal((await h.mailsFor(email, 'We are live')).length, 1);
  });

  it('REG-008 bounced addresses are excluded from broadcasts', async () => {
    const email = await h.activeSubscriber({ notifyLaunch: true });
    await h.api('POST', '/api/webhooks/email-events', {
      body: { type: 'bounce', email },
      headers: { 'X-Webhook-Secret': process.env.WEBHOOK_SECRET },
    });
    await broadcast({ kind: 'launch', campaignKey: 'reg-008', eligibleColumn: 'notify_launch' });
    assert.equal((await h.mailsFor(email, 'We are live')).length, 0);
  });

  it('REG-009 unknown API routes return JSON, not an HTML error page', async () => {
    const res = await h.api('GET', '/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.body.error, 'Not found');
  });

  it('REG-010 oversized payloads are rejected cleanly without leaking a stack trace', async () => {
    const raw = JSON.stringify({ email: `${'x'.repeat(20000)}@example.test`, consent: true });
    const res = await h.api('POST', '/api/subscribe', { raw });
    assert.equal(res.status, 413);
    assert.equal(/\n\s+at /.test(res.text), false);
  });
});
