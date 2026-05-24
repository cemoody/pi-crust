/**
 * Meta-tests for the process-hygiene guard.
 *
 * Each test reaps its own children INSIDE the test body before returning,
 * so the guard's own afterEach (which runs against the same hooks list)
 * doesn't see leftovers from this file's tests.
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { __processHygiene } from "./process-hygiene.js";

async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

function reap(pid: number | undefined) {
  if (pid == null) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* not a pgroup leader */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

const repoRoot = path.resolve(__dirname, "../..");

describe("process-hygiene guard", () => {
  it("flags a leaked dev-api.mjs process via LEAK_PATTERNS (regression for 2026-05-23 outage)", async () => {
    // Simulate the exact shape of the 2026-05-23 outage: an orphaned
    // dev-api.mjs running in a sandbox. The guard MUST flag it.
    const devApiScript = path.join(repoRoot, "scripts", "dev-api.mjs");
    expect(fs.existsSync(devApiScript), "dev-api.mjs must exist for this test").toBe(true);

    // Point at a nonexistent binary so the supervisor's loop never actually
    // makes progress (and so we know it'll be alive long enough to detect).
    const child = spawn(process.execPath, [
      devApiScript, "--", "/nonexistent-binary-for-hygiene-meta-test",
    ], {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        DEV_API_RESTART_MS: "100",
        DEV_API_MAX_FAILED_SPAWNS_BEFORE_GIVE_UP: "10000", // don't trip the circuit breaker
      },
    });
    child.unref();
    try {
      await sleep(200); // let /proc reflect the new pid

      const suspects = __processHygiene.leakSuspects(__processHygiene.readProc());
      expect(
        suspects,
        `dev-api.mjs leak at pid=${child.pid} should be flagged by leakSuspects()`,
      ).toContain(child.pid!);
    } finally {
      reap(child.pid);
      await sleep(100); // give the kernel a moment so the guard's afterEach sees it gone
    }
  }, 8_000);

  it("does NOT flag the test runner itself or PID 1", () => {
    const flagged = __processHygiene.leakSuspects(__processHygiene.readProc());
    expect(flagged, "test runner itself must not be self-flagged").not.toContain(process.pid);
    expect(flagged, "PID 1 must never be flagged").not.toContain(1);
  });

  it("does NOT flag unrelated subprocesses (false-positive resistance)", async () => {
    // Spawn a random node process that has nothing to do with our leak
    // patterns. The guard must ignore it. This is what regressed in the
    // first draft of the guard and broke 20+ unrelated tests.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000);"], {
      stdio: "ignore",
    });
    try {
      await sleep(150);
      const suspects = __processHygiene.leakSuspects(__processHygiene.readProc());
      expect(
        suspects,
        `unrelated subprocess pid=${child.pid} must not be flagged as a leak`,
      ).not.toContain(child.pid!);
    } finally {
      reap(child.pid);
      await new Promise<void>((r) => child.once("exit", () => r()));
    }
  });

  it("descendantsOrTagged() (helper) finds live descendants of the test process", async () => {
    // This helper is exposed for diagnostic use; verify it works as
    // advertised. Used by future tests that want to check leak *shapes*
    // beyond LEAK_PATTERNS.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000);"], {
      stdio: "ignore",
    });
    try {
      await sleep(100);
      const descendants = __processHygiene.descendantsOrTagged(__processHygiene.readProc());
      expect(descendants).toContain(child.pid!);
    } finally {
      reap(child.pid);
      await new Promise<void>((r) => child.once("exit", () => r()));
    }
  });
});
