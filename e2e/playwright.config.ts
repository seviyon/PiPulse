import { defineConfig, devices } from '@playwright/test';

const ci = Boolean(process.env['CI']);

export default defineConfig({
  testDir: 'specs',
  testMatch: '**/*.e2e.ts',
  outputDir: 'test-results',
  // Every test starts its own server, so tests never share state and can run side by side.
  fullyParallel: true,
  // A retry would hide the flake a trace explains.
  retries: 0,
  ...(ci ? { workers: 2 } : {}),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  projects: [
    { name: 'chromium', testIgnore: /\/https\//, use: { ...devices['Desktop Chrome'] } },
    {
      // The only project that skips certificate verification in the browser; the HTTPS fixture
      // checks the served chain itself with Node first.
      name: 'chromium-https',
      testMatch: /\/https\/.*\.e2e\.ts$/,
      use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true }
    }
  ]
});
