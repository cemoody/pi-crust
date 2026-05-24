import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  // promo-screenshots.spec.ts has its own dedicated config
  // (playwright.promo.config.ts) that boots a different seed + ports.
  // Skip it here so `playwright test` (default) doesn't pull it in.
  testIgnore: /promo-screenshots\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'rm -rf .tmp/playwright-sessions && PI_CRUST_PROJECT_ROOT=$PWD node scripts/seed-mock-session.mjs && PI_CRUST_USE_MOCK=1 PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/playwright-sessions PI_CRUST_API_PORT=9787 npm run dev:api',
      url: 'http://127.0.0.1:9787/api/health',
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: 'VITE_PI_CRUST_API_BASE=http://127.0.0.1:9787 npm run dev -- --host 127.0.0.1 --port 5174',
      url: 'http://127.0.0.1:5174/',
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
