import { defineConfig, devices } from '@playwright/test';

// Dedicated config for the terminal-tab spec so it can run on its own ports
// without colliding with other live pi-crust instances on 5174/9787.
const WEB_PORT = 5188;
const API_PORT = 9788;

export default defineConfig({
  testDir: './tests/playwright',
  testMatch: /terminal-tab-wterm\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `rm -rf .tmp/playwright-sessions && PI_CRUST_PROJECT_ROOT=$PWD node scripts/seed-mock-session.mjs && PI_CRUST_USE_MOCK=1 PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/playwright-sessions PI_CRUST_API_PORT=${API_PORT} npm run dev:api`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `VITE_PI_CRUST_API_BASE=http://127.0.0.1:${API_PORT} npm run dev -- --host 127.0.0.1 --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
