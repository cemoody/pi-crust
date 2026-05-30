import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // The scenario tier is a separate, heavyweight, out-of-process suite that
    // stands up the whole deployment topology and deliberately contains RED
    // specs for not-yet-built robustness features. It runs only via
    // `npm run scenarios` (vitest.scenarios.config.ts), never in the default
    // `npm test` / CI suite.
    exclude: ["node_modules/**", "dist/**", "tests/scenarios/**"],
    testTimeout: 10_000,
    // Generic process & tmpdir hygiene guard. Makes any test that leaks a
    // child process or sandbox dir fail loudly instead of leaving CPU bombs
    // on the box. See tests/setup/process-hygiene.ts for the rationale.
    setupFiles: ["tests/setup/process-hygiene.ts"],
  },
});
