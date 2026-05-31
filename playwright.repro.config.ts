import { defineConfig, devices } from "@playwright/test";

// Standalone config for the artifact-500 reproduction: NO webServer (we target
// the already-running live dev server), single chromium project.
export default defineConfig({
  testDir: "./tests/repro",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.REPRO_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
