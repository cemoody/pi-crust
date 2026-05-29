import { defineConfig, devices } from '@playwright/test';

// Dedicated config that builds the web app with the Socket.IO realtime
// transport ENABLED (VITE_PI_CRUST_REALTIME=socketio) so the cross-tab
// leader-election path is exercised end-to-end. Separate ports so it can run
// alongside the default (SSE) suite without clashing.
export default defineConfig({
  testDir: './tests/playwright-realtime',
  timeout: 45_000,
  fullyParallel: false,
  // These specs assert the server's PROCESS-GLOBAL realtime connection count,
  // so they must run one-at-a-time against the single shared dev API. Parallel
  // workers would share that count and make the assertions flap.
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5176',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      // The seed script hardcodes .tmp/playwright-sessions, so the API must read
      // from the same root (matches playwright.config.ts).
      command: 'PI_CRUST_PROJECT_ROOT=$PWD node scripts/seed-mock-session.mjs && PI_CRUST_USE_MOCK=1 PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/playwright-sessions PI_CRUST_API_PORT=9789 npm run dev:api',
      url: 'http://127.0.0.1:9789/api/health',
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: 'VITE_PI_CRUST_API_BASE=http://127.0.0.1:9789 VITE_PI_CRUST_REALTIME=socketio npm run dev -- --host 127.0.0.1 --port 5176',
      url: 'http://127.0.0.1:5176/',
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
