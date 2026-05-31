import { defineConfig, devices } from "@playwright/test";

// Dedicated config for the artifact rendering specs so they can run alongside
// other dev servers (uses free ports 9911/5311 instead of the default
// 9787/5174). Boots the mock API + vite with the bundled artifacts extension.
// Matches every artifact-*.spec.ts so the static, live, and multi-artifact
// suites can all be run locally with one command.
export default defineConfig({
  testDir: "./tests/playwright",
  testMatch: /artifact-[a-z-]+\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5311",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command:
        "rm -rf .tmp/playwright-sessions && PI_CRUST_PROJECT_ROOT=$PWD node scripts/seed-mock-session.mjs && PI_CRUST_USE_MOCK=1 PI_CRUST_PROJECT_ROOT=$PWD PI_CRUST_SESSION_ROOT=$PWD/.tmp/playwright-sessions PI_CRUST_API_PORT=9911 npm run dev:api",
      url: "http://127.0.0.1:9911/api/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "VITE_PI_CRUST_PROXY_TARGET=http://127.0.0.1:9911 npm run dev -- --host 127.0.0.1 --port 5311",
      url: "http://127.0.0.1:5311/",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
