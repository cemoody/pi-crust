import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright-production',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:8798',
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run build && rm -rf .tmp/playwright-production-sessions && PI_CRUST_PROJECT_ROOT=$PWD node scripts/seed-mock-session.mjs && PI_CRUST_OPEN=0 PI_CRUST_USE_MOCK=1 PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/playwright-production-sessions PI_CRUST_API_PORT=8798 node bin/pi-crust.mjs',
    url: 'http://127.0.0.1:8798/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
