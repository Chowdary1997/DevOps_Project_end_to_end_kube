'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, buildCampaign } = require('../../src/email');

const subscriber = { email: 'ada@example.com', unsubscribe_token: 'b'.repeat(64) };

test('withRetry retries transient failures and then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('connection timeout');
    return 'ok';
  }, { attempts: 4, baseMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry does not retry permanent SMTP 5xx replies', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('mailbox unavailable'), { responseCode: 550 });
    }, { attempts: 4, baseMs: 1 }),
    /mailbox unavailable/,
  );
  assert.equal(calls, 1);
});

test('withRetry gives up after the configured number of attempts', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new Error('network'); }, { attempts: 3, baseMs: 1 }));
  assert.equal(calls, 3);
});

test('launch campaign includes a manage and unsubscribe link', () => {
  const message = buildCampaign('launch', subscriber);
  assert.match(message.text, /api\/unsubscribe\?token=b{64}/);
  assert.match(message.html, /Manage or unsubscribe/);
  assert.match(message.subject, /live/i);
});

test('date update campaign formats the launch date in UTC', () => {
  const message = buildCampaign('date_update', subscriber, { launchAt: '2026-12-01T09:00:00.000Z' });
  assert.match(message.text, /01 Dec 2026 09:00:00 GMT/);
});

test('unknown campaign kinds are rejected', () => {
  assert.throws(() => buildCampaign('spam', subscriber), /Unknown campaign kind/);
});
