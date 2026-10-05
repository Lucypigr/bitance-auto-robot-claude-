import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', testIgnore: /mobile\.spec\.js/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', testMatch: /mobile\.spec\.js/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    { command: 'node scripts/serve.mjs public 4173', url: 'http://localhost:4173/index.html', reuseExistingServer: true, timeout: 20000 },
    { command: 'node scripts/serve.mjs docs 4174', url: 'http://localhost:4174/index.html', reuseExistingServer: true, timeout: 20000 },
  ],
});
