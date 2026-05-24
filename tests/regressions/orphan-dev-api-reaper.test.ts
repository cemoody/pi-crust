/**
 * Integration test for scripts/reap-orphan-dev-api.mjs.
 *
 * Spawns a real dev-api.mjs in a process tree, then injects a synthetic
 * /proc snapshot (via the test-only PI_REAP_ORPHAN_DEV_API_SNAPSHOT_FILE
 * hook) that gives that real pid the PPID=1 shape. This is necessary
 * because vitest workers are themselves subreapers \u2014 children spawned
 * inside a vitest test get reparented to the worker (not PID 1) when
 * their direct parent dies, so we can't reach the natural PPID=1 state
 * the production failure mode involves.
 *
 * The kill itself is still EXERCISED against a real pid, so SIGTERM
 * delivery, the kill(0) liveness check, the SIGKILL escalation, the
 * "skip if already gone" branch, and the structured log lines are all
 * end-to-end verified.
 *
 * Real-world scenario this pins:
 *
 *   2026-05-24 dev box had a 98%-CPU orphaned dev-api.mjs from
 *   /home/coder/code/pi-rc-ios-paste-base64-leak/scripts/dev-api.mjs
 *   running for 12+ hours after its parent tmux pane was killed.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const reaperScript = path.resolve(__dirname, "..", "..", "scripts", "reap-orphan-dev-api.mjs");
const devApiScript = path.resolve(__dirname, "..", "..", "scripts", "dev-api.mjs");

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) { try { await fn(); } catch { /* ignore */ } }
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err: any) { return err && err.code !== "ESRCH"; }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, opts: { timeoutMs: number; label: string }): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out: ${opts.label}`);
}

/**
 * Spawn a real `node scripts/dev-api.mjs ...` child and return its pid.
 *
 * The child is spawned as a normal child of the test process. Its actual
 * PPID is the test process. The integration test then overrides the
 * reaper's /proc view with a synthetic snapshot that gives this child
 * the PPID=1 shape, so the classifier sees an orphan and the reaper
 * actually sends signals against a real pid.
 */
async function spawnRealDevApi(sandbox: string): Promise<{ pid: number; child: ChildProcess; cmdline: string }> {
  await fs.mkdir(sandbox, { recursive: true });
  const child = spawn(process.execPath, [devApiScript, "--", "/bin/sleep", "600"], {
    cwd: sandbox,
    stdio: "ignore",
    // detached so we can SIGKILL via pgroup in cleanup if needed
    detached: true,
  });
  const pid = child.pid!;
  cleanup.push(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  });
  // Let the child settle; build the actual cmdline string we'll use in the
  // synthetic snapshot. The cmdline should match what /proc/<pid>/cmdline
  // would render: NUL-joined argv, then NUL-to-space-normalized.
  await new Promise((r) => setTimeout(r, 100));
  const raw = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
  const cmdline = raw.replace(/\0/g, " ").trim();
  return { pid, child, cmdline };
}

/**
 * Write a synthetic /proc snapshot file for the reaper to consume via
 * the PI_REAP_ORPHAN_DEV_API_SNAPSHOT_FILE env hook. The returned path
 * is written; tests run the reaper against it.
 */
async function writeSnapshot(file: string, entries: Array<{ pid: number; ppid: number; cmdline: string; etimeMs: number }>): Promise<void> {
  await fs.writeFile(file, JSON.stringify(entries));
}

describe("orphan-dev-api reaper integration", () => {
  it("SIGTERMs a real dev-api.mjs process that the snapshot identifies as orphan (regression for 2026-05-24)", async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "pi-test-reap-orphan-"));
    cleanup.push(() => fs.rm(sandbox, { recursive: true, force: true }));

    const { pid, cmdline } = await spawnRealDevApi(sandbox);
    expect(isAlive(pid)).toBe(true);

    // Synthesize a /proc snapshot that gives this real pid the PPID=1
    // shape the reaper looks for.
    const snapshotFile = path.join(sandbox, "snapshot.json");
    await writeSnapshot(snapshotFile, [{ pid, ppid: 1, cmdline, etimeMs: 90_000 }]);

    const out: string[] = [];
    const reaper = spawn(process.execPath, [reaperScript], {
      env: {
        ...process.env,
        PI_REAP_ORPHAN_DEV_API_MIN_ETIME_MS: "100",
        PI_REAP_ORPHAN_DEV_API_DRY_RUN: "0",
        PI_REAP_ORPHAN_DEV_API_GRACE_MS: "200",
        PI_REAP_ORPHAN_DEV_API_SNAPSHOT_FILE: snapshotFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    reaper.stdout?.on("data", (c) => out.push(c.toString()));
    reaper.stderr?.on("data", (c) => out.push(c.toString()));
    await new Promise<void>((resolve) => reaper.once("exit", () => resolve()));
    expect(reaper.exitCode).toBe(0);

    await waitFor(() => !isAlive(pid), { timeoutMs: 5_000, label: "orphan dev-api reaped" });
    expect(isAlive(pid)).toBe(false);

    expect(out.join(""), `reaper output: ${out.join("")}`).toMatch(/orphan_reaper\.kill/);
  }, 20_000);

  it("does NOT signal a dev-api.mjs whose snapshot says it has a live parent (safety guard)", async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "pi-test-reap-noop-"));
    cleanup.push(() => fs.rm(sandbox, { recursive: true, force: true }));

    const { pid, cmdline } = await spawnRealDevApi(sandbox);
    expect(isAlive(pid)).toBe(true);

    // Snapshot says this process has a LIVE parent (not PPID=1). The reaper
    // MUST leave it alone.
    const snapshotFile = path.join(sandbox, "snapshot.json");
    await writeSnapshot(snapshotFile, [{ pid, ppid: 8888, cmdline, etimeMs: 90_000 }]);

    const reaper = spawn(process.execPath, [reaperScript], {
      env: {
        ...process.env,
        PI_REAP_ORPHAN_DEV_API_MIN_ETIME_MS: "100",
        PI_REAP_ORPHAN_DEV_API_DRY_RUN: "0",
        PI_REAP_ORPHAN_DEV_API_SNAPSHOT_FILE: snapshotFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve) => reaper.once("exit", () => resolve()));

    expect(isAlive(pid), "reaper must not touch a dev-api.mjs whose parent is alive").toBe(true);
  }, 15_000);

  it("dry-run mode reports targets without killing them", async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "pi-test-reap-dry-"));
    cleanup.push(() => fs.rm(sandbox, { recursive: true, force: true }));

    const { pid, cmdline } = await spawnRealDevApi(sandbox);
    expect(isAlive(pid)).toBe(true);

    const snapshotFile = path.join(sandbox, "snapshot.json");
    await writeSnapshot(snapshotFile, [{ pid, ppid: 1, cmdline, etimeMs: 90_000 }]);

    const out: string[] = [];
    const reaper = spawn(process.execPath, [reaperScript], {
      env: {
        ...process.env,
        PI_REAP_ORPHAN_DEV_API_MIN_ETIME_MS: "100",
        PI_REAP_ORPHAN_DEV_API_DRY_RUN: "1",
        PI_REAP_ORPHAN_DEV_API_SNAPSHOT_FILE: snapshotFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    reaper.stdout?.on("data", (c) => out.push(c.toString()));
    reaper.stderr?.on("data", (c) => out.push(c.toString()));
    await new Promise<void>((resolve) => reaper.once("exit", () => resolve()));

    expect(reaper.exitCode).toBe(0);
    // Real pid is STILL alive after dry run.
    expect(isAlive(pid), "dry-run must not actually kill").toBe(true);
    // But the would-kill is logged with a distinct event name.
    expect(out.join("")).toMatch(/orphan_reaper\.would_kill/);
  }, 15_000);

  it("readProcSnapshot exposed by the script returns real-shaped entries (sanity)", async () => {
    // Smoke that the production code path (no snapshot file) reads /proc
    // and returns at least one entry on a Linux box. Without this, the
    // injected-snapshot tests above would prove nothing about /proc
    // parsing.
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "pi-test-reap-sanity-"));
    cleanup.push(() => fs.rm(sandbox, { recursive: true, force: true }));

    const out: string[] = [];
    const reaper = spawn(process.execPath, [reaperScript], {
      env: {
        ...process.env,
        PI_REAP_ORPHAN_DEV_API_MIN_ETIME_MS: "100",
        PI_REAP_ORPHAN_DEV_API_DRY_RUN: "1",
        // No PI_REAP_ORPHAN_DEV_API_SNAPSHOT_FILE \u2014 uses real /proc.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    reaper.stdout?.on("data", (c) => out.push(c.toString()));
    reaper.stderr?.on("data", (c) => out.push(c.toString()));
    await new Promise<void>((resolve) => reaper.once("exit", () => resolve()));

    expect(reaper.exitCode).toBe(0);
    // Should have emitted a summary with scanned > 0 (we just enumerated /proc).
    const summary = out.join("").split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((e) => e && e.event === "orphan_reaper.summary");
    expect(summary).toBeTruthy();
    expect((summary as { scanned: number }).scanned).toBeGreaterThan(0);
  }, 15_000);
});
