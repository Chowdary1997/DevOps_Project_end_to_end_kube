const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // tests share one mail sink, so run serially
  reporter: [
    ['list'],
    ['junit', { outputFile: 'reports/e2e.xml' }],
    ['html', { open: 'never', outputFolder: 'reports/playwright' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
