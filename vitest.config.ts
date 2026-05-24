import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 10_000,
    // Generic process & tmpdir hygiene guard. Makes any test that leaks a
    // child process or sandbox dir fail loudly instead of leaving CPU bombs
    // on the box. See tests/setup/process-hygiene.ts for the rationale.
    setupFiles: ["tests/setup/process-hygiene.ts"],
  },
});
