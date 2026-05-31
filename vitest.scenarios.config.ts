import { defineConfig } from "vitest/config";

/**
 * Scenario tier: heavyweight, out-of-process integration tests that stand up
 * the FULL live topology (dev-api loop + detached pirpc supervisors + fake-pi
 * workers + git-puller + a fake git remote) in a sandbox and perturb it.
 *
 * These are slow (seconds each, real process trees) and stateful (bind ports,
 * spawn detached children), so they live in their own tier outside the default
 * `npm test`. Run with `npm run scenarios`.
 *
 * Sequential by design: each scenario owns real ports / process trees; running
 * them in parallel within one worker invites cross-test interference even
 * though every stack uses a random port. `fileParallelism: false` keeps the
 * box calm and the failures legible.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/scenarios/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Reuse the same process/tmpdir hygiene guard as the rest of the suite.
    setupFiles: ["tests/setup/process-hygiene.ts"],
  },
});
