import { defineConfig, devices } from "@playwright/test";

// Dedicated config for the PR Story rendering spec so it can run alongside
// other dev servers (uses free ports 9921/5321 instead of the default
// 9787/5174 or the artifact suite's 9911/5311). Boots the mock API + vite with
// the bundled extensions and the seeded PR Story tool-artifact session.
export default defineConfig({
  testDir: "./tests/playwright",
  testMatch: /pr-story-artifact\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5321",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command:
        "rm -rf .tmp/playwright-sessions && PI_CRUST_PROJECT_ROOT=$PWD node scripts/seed-mock-session.mjs && PI_CRUST_USE_MOCK=1 PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/playwright-sessions PI_CRUST_API_PORT=9921 npm run dev:api",
      url: "http://127.0.0.1:9921/api/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "VITE_PI_CRUST_PROXY_TARGET=http://127.0.0.1:9921 npm run dev -- --host 127.0.0.1 --port 5321",
      url: "http://127.0.0.1:5321/",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
