import { defineConfig, devices } from '@playwright/test';

/**
 * Nightly/mobile-realism suite. PR CI stays Chromium-only for speed, but the
 * bugs this app has historically seen on phones (BFCache restore,
 * visibilitychange reconnect, clipboard/input behavior) need WebKit coverage.
 */
export default defineConfig({
  testDir: './tests/playwright',
  testMatch: [
    'mobile-hmr-reconnect.spec.ts',
    'mobile-input-zoom.spec.ts',
    'mobile-tool-wrap-repro.spec.ts',
  ],
  timeout: 45_000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5178',
    trace: 'on-first-retry',
    ...devices['iPhone 15'],
  },
  projects: [
    { name: 'webkit-mobile', use: { ...devices['iPhone 15'] } },
  ],
  webServer: [
    {
      command: 'rm -rf .tmp/playwright-mobile-webkit-sessions && PI_CRUST_PROJECT_ROOT=$PWD node scripts/seed-mock-session.mjs && PI_CRUST_USE_MOCK=1 PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/playwright-mobile-webkit-sessions PI_CRUST_API_PORT=9791 npm run dev:api',
      url: 'http://127.0.0.1:9791/api/health',
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: 'VITE_PI_CRUST_API_BASE=http://127.0.0.1:9791 npm run dev -- --host 127.0.0.1 --port 5178',
      url: 'http://127.0.0.1:5178/',
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
