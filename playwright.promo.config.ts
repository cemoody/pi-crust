/**
 * Playwright config dedicated to README / promo screenshots. Boots its own
 * mock API + vite dev server on different ports than playwright.config.ts so
 * the two can coexist, and seeds a richer set of sessions (vega-lite,
 * self-contained HTML dashboard, cron-spawned, drafting flow) via
 * `scripts/seed-promo-sessions.mjs`.
 *
 * Run with: npm run promo
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright",
  testMatch: /promo-screenshots\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5176",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "rm -rf .tmp/promo-sessions && PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/promo-sessions node scripts/seed-promo-sessions.mjs && PI_CRUST_USE_MOCK=1 PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/promo-sessions PI_CRUST_API_PORT=9789 npm run dev:api",
      url: "http://127.0.0.1:9789/api/health",
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: "VITE_PI_CRUST_API_BASE=http://127.0.0.1:9789 npm run dev -- --host 127.0.0.1 --port 5176",
      url: "http://127.0.0.1:5176/",
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
});
