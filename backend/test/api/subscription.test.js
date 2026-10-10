'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/harness');

before(() => h.startServer());
after(() => h.stopServer());
beforeEach(async () => {
  await h.resetState();
  await h.resetMail();
});

describe('health and configuration', () => {
  it('reports healthy when the database is reachable', async () => {
    const res = await h.api('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('exposes the launch date and launched flag', async () => {
    const res = await h.api('GET', '/api/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.launched, false);
    assert.ok(res.body.launchAt);
  });
});

describe('subscribe input validation', () => {
  for (const email of ['', 'not-an-email', 'a@b', '@example.com', 'a b@example.com']) {
    it(`rejects invalid address ${JSON.stringify(email)}`, async () => {
      const res = await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /valid email/);
    });
  }

  it('requires explicit consent', async () => {
    const res = await h.api('POST', '/api/subscribe', { body: { email: h.uniqueEmail(), consent: false } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /privacy notice/);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await h.api('POST', '/api/subscribe', { raw: '{"email":' });
    assert.equal(res.status, 400);
  });

  it('honeypot: a filled hidden field gets a fake success and creates nothing', async () => {
    const email = h.uniqueEmail();
    const res = await h.api('POST', '/api/subscribe', { body: { email, consent: true, website: 'spam' } });
    assert.equal(res.status, 202);
    assert.equal(await h.subscriberRow(email), null);
    assert.equal((await h.mailsFor(email)).length, 0);
  });
});

describe('double opt-in', () => {
  it('stores a pending subscriber and sends a confirmation email', async () => {
    const email = h.uniqueEmail();
    const res = await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    assert.equal(res.status, 202);
    assert.match(res.body.message, /Check your inbox/);
    assert.equal((await h.subscriberRow(email)).status, 'pending');
    const [mail] = await h.waitForMails(email, 1, { subject: 'Confirm' });
    assert.match(mail.Text, /api\/confirm\?token=[a-f0-9]{64}/);
  });

  it('activates the subscriber through the emailed link and records consent', async () => {
    const email = h.uniqueEmail();
    await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    const [mail] = await h.waitForMails(email, 1, { subject: 'Confirm' });
    const res = await h.api('GET', `/api/confirm?token=${h.tokenFrom(mail.Text)}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /subscribed/);
    assert.equal((await h.subscriberRow(email)).status, 'active');
    assert.deepEqual((await h.consentActions(email)).sort(), ['confirm', 'subscribe']);
  });

  it('confirmation links are single use', async () => {
    const email = h.uniqueEmail();
    await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    const [mail] = await h.waitForMails(email, 1, { subject: 'Confirm' });
    const token = h.tokenFrom(mail.Text);
    assert.equal((await h.api('GET', `/api/confirm?token=${token}`)).status, 200);
    const again = await h.api('GET', `/api/confirm?token=${token}`);
    assert.equal(again.status, 400);
    assert.match(again.text, /expired/);
  });

  it('rejects malformed confirmation tokens', async () => {
    const res = await h.api('GET', '/api/confirm?token=abc');
    assert.equal(res.status, 400);
    assert.match(res.text, /invalid/);
  });

  it('re-subscribing invalidates the earlier confirmation link', async () => {
    const email = h.uniqueEmail();
    await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    const [first] = await h.waitForMails(email, 1, { subject: 'Confirm' });
    const oldToken = h.tokenFrom(first.Text);
    await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    const mails = await h.waitForMails(email, 2, { subject: 'Confirm' });
    const newToken = mails.map((m) => h.tokenFrom(m.Text)).find((t) => t !== oldToken);
    assert.equal((await h.api('GET', `/api/confirm?token=${oldToken}`)).status, 400);
    assert.equal((await h.api('GET', `/api/confirm?token=${newToken}`)).status, 200);
  });
});

describe('preferences and unsubscribe', () => {
  it('updates notification preferences from the manage link', async () => {
    const email = await h.activeSubscriber();
    const { unsubscribe_token: token } = await h.subscriberRow(email);
    const res = await h.api('POST', '/api/preferences', {
      raw: `token=${token}&notifyLaunch=on`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 200);
    const row = await h.subscriberRow(email);
    assert.equal(row.notify_launch, true);
    assert.equal(row.notify_updates, false);
  });

  it('one-click unsubscribe stops all email and records consent', async () => {
    const email = await h.activeSubscriber();
    const { unsubscribe_token: token } = await h.subscriberRow(email);
    const res = await h.api('POST', `/api/unsubscribe?token=${token}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /unsubscribed/);
    assert.equal((await h.subscriberRow(email)).status, 'unsubscribed');
    assert.ok((await h.consentActions(email)).includes('unsubscribe'));
  });

  it('an unknown unsubscribe token gets the same page as a valid one', async () => {
    const res = await h.api('POST', `/api/unsubscribe?token=${'0'.repeat(64)}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /unsubscribed/);
  });

  it('an unsubscribed address can subscribe again', async () => {
    const email = await h.activeSubscriber();
    const { unsubscribe_token: token } = await h.subscriberRow(email);
    await h.api('POST', `/api/unsubscribe?token=${token}`);
    const res = await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    assert.equal(res.status, 202);
    assert.equal((await h.subscriberRow(email)).status, 'pending');
  });
});

describe('email event webhook', () => {
  it('rejects events without the webhook secret', async () => {
    const res = await h.api('POST', '/api/webhooks/email-events', { body: { type: 'bounce', email: 'a@example.test' } });
    assert.equal(res.status, 401);
  });

  it('a bounce blocks the address from future subscriptions', async () => {
    const email = await h.activeSubscriber();
    const res = await h.api('POST', '/api/webhooks/email-events', {
      body: { type: 'bounce', email },
      headers: { 'X-Webhook-Secret': process.env.WEBHOOK_SECRET },
    });
    assert.equal(res.status, 204);
    assert.equal((await h.subscriberRow(email)).status, 'bounced');
    await h.api('POST', '/api/subscribe', { body: { email, consent: true } });
    assert.equal((await h.subscriberRow(email)).status, 'bounced');
    assert.equal((await h.mailsFor(email, 'Confirm')).length, 1);
  });
});

describe('admin API', () => {
  it('rejects requests without a valid admin token', async () => {
    const put = await h.api('PUT', '/api/admin/launch-date', { body: { launchAt: '2027-01-01T00:00:00Z' } });
    assert.equal(put.status, 401);
    const post = await h.api('POST', '/api/admin/launch', { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(post.status, 401);
  });

  it('rejects an invalid launch date', async () => {
    const res = await h.api('PUT', '/api/admin/launch-date', { body: { launchAt: 'next tuesday' }, headers: h.adminAuth });
    assert.equal(res.status, 400);
  });

  it('a date change notifies only subscribers who opted into date updates', async () => {
    const optedIn = await h.activeSubscriber({ notifyUpdates: true });
    const optedOut = await h.activeSubscriber({ notifyUpdates: false });
    const res = await h.api('PUT', '/api/admin/launch-date', {
      body: { launchAt: '2027-01-15T10:00:00Z' },
      headers: h.adminAuth,
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.notifications, 'queued');
    const [mail] = await h.waitForMails(optedIn, 1, { subject: 'launch date' });
    assert.match(mail.Text, /15 Jan 2027 10:00:00 GMT/);
    await h.sleep(1000);
    assert.equal((await h.mailsFor(optedOut, 'launch date')).length, 0);
  });

  it('launch announcement reaches eligible subscribers once, then the API refuses a second launch', async () => {
    const yes = await h.activeSubscriber({ notifyLaunch: true });
    const no = await h.activeSubscriber({ notifyLaunch: false });
    const first = await h.api('POST', '/api/admin/launch', { headers: h.adminAuth });
    assert.equal(first.status, 202);
    await h.waitForMails(yes, 1, { subject: 'We are live' });
    await h.sleep(1000);
    assert.equal((await h.mailsFor(no, 'We are live')).length, 0);
    const second = await h.api('POST', '/api/admin/launch', { headers: h.adminAuth });
    assert.equal(second.status, 409);
  });

  it('subscribers who confirm after launch still receive the launch email', async () => {
    await h.api('POST', '/api/admin/launch', { headers: h.adminAuth });
    const late = await h.activeSubscriber({ notifyLaunch: true });
    await h.waitForMails(late, 1, { subject: 'We are live' });
  });
});
