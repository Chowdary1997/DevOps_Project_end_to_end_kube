const { test, expect } = require('@playwright/test');

const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';

async function waitForToken(request, email) {
  for (let i = 0; i < 40; i += 1) {
    const { messages = [] } = await (await request.get(`${MAILPIT}/api/v1/messages`)).json();
    const found = messages.find((m) => m.To.some((t) => t.Address === email));
    if (found) {
      const full = await (await request.get(`${MAILPIT}/api/v1/message/${found.ID}`)).json();
      return full.Text.match(/token=([a-f0-9]{64})/)[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No confirmation email for ${email}`);
}

test.beforeEach(async ({ request }) => {
  await request.delete(`${MAILPIT}/api/v1/messages`);
});

test('landing page renders the hero, countdown and subscribe form', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('extraordinary');
  await expect(page.locator('#countdown')).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('invalid email shows an inline validation error', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('not-an-email');
  await page.getByRole('button', { name: 'Notify me' }).click();
  await expect(page.locator('#email-error')).toContainText('valid email');
});

test('full journey: subscribe, receive the email, confirm', async ({ page, request }) => {
  const email = `e2e-${Date.now()}@example.test`;
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel(/I agree/).check();
  await page.getByRole('button', { name: 'Notify me' }).click();
  await expect(page.locator('#form-status')).toContainText('Check your inbox');

  const token = await waitForToken(request, email);
  await page.goto(`/api/confirm?token=${token}`);
  await expect(page.locator('h1')).toContainText('subscribed');
});

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('has no horizontal scrolling and keeps the form usable', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole('button', { name: 'Notify me' })).toBeVisible();
  });
});
