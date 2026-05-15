/**
 * Integration test for scripts/dev-api.mjs.
 *
 * These tests pin the three invariants that distinguish this supervisor
 * from the old `tsx watch` default:
 *
 *   1. On file change in src/server, the running child gets SIGTERM and
 *      a new child is spawned (the self-edit happy path).
 *   2. If the child crashes during startup (simulating tsx hitting a
 *      mid-pull corrupt package.json), the supervisor does NOT hang — it
 *      respawns on the configured backoff. This is THE bug `tsx watch`
 *      had: it stayed alive waiting for the next file event, leaving the
 *      api down indefinitely.
 *   3. A burst of file changes (mimics a git pull's multi-file rewrite)
 *      coalesces into a single restart, not N.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(__dirname, "../../scripts/dev-api.mjs");
const projectRoot = path.resolve(__dirname, "../..");

let supervisor: ChildProcess | null = null;
let watchedFiles: string[] = [];
const logChunks: string[] = [];

afterEach(async () => {
  if (supervisor && !supervisor.killed) {
    supervisor.kill("SIGKILL");
    await new Promise<void>((resolve) => supervisor!.once("exit", () => resolve()));
  }
  supervisor = null;
  for (const f of watchedFiles) {
    try { await fs.unlink(f); } catch { /* may already be gone */ }
  }
  watchedFiles = [];
  logChunks.length = 0;
});

interface SupOptions {
  /** Child command argv (e.g. ["bash","-c","..."]). */
  cmd: string[];
  /** Optional env overrides for the supervisor (DEV_API_DEBOUNCE_MS etc). */
  env?: Record<string, string>;
}

function startSupervisor(opts: SupOptions): Promise<void> {
  return new Promise((resolve) => {
    supervisor = spawn(process.execPath, [scriptPath, "--", ...opts.cmd], {
      cwd: projectRoot,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisor.stdout!.on("data", (chunk) => logChunks.push(chunk.toString()));
    supervisor.stderr!.on("data", (chunk) => logChunks.push(chunk.toString()));
    // Give it a beat to print its initial "spawned" + "watching" lines.
    setTimeout(resolve, 200);
  });
}

function fullLog(): string {
  return logChunks.join("");
}

async function waitForLog(predicate: (log: string) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(fullLog())) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForLog timed out. Saw:\n${fullLog()}`);
}

async function writeWatched(rel: string, content: string): Promise<void> {
  const abs = path.join(projectRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  watchedFiles.push(abs);
}

describe("dev-api.mjs supervisor", () => {
  it("SIGTERMs the child and respawns when a file under src/server changes", async () => {
    await startSupervisor({
      // A child that runs forever and traps SIGTERM cleanly.
      cmd: ["bash", "-c", 'echo "child up pid=$$"; trap "echo child got TERM; exit 0" TERM; while true; do sleep 1; done'],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "300" },
    });
    await waitForLog((l) => /spawned pid=\d+/.test(l));
    const firstSpawnMatch = fullLog().match(/spawned pid=(\d+)/);
    expect(firstSpawnMatch, "first spawn line").toBeTruthy();

    await writeWatched(`src/server/__supervisor_test_${process.pid}.ts`, "// change");
    await waitForLog((l) => /change detected/.test(l));
    await waitForLog((l) => (l.match(/spawned pid=\d+/g) ?? []).length >= 2);

    const spawns = fullLog().match(/spawned pid=(\d+)/g) ?? [];
    expect(spawns.length, "expected exactly 2 spawn lines (initial + 1 restart)").toBe(2);
  }, 15_000);

  it("respawns the child after a crash-on-startup (the bug `tsx watch` had)", async () => {
    // Child that exits immediately with code 1. With tsx watch this leaves
    // the supervisor hung; here the supervisor should churn respawns.
    await startSupervisor({
      cmd: ["bash", "-c", 'echo "boot, will crash"; exit 1'],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "150" },
    });
    // Wait for at least 3 spawn lines (initial + 2 respawns) within 2.5s.
    await waitForLog((l) => (l.match(/spawned pid=\d+/g) ?? []).length >= 3, 3_000);

    const spawns = fullLog().match(/spawned pid=\d+/g) ?? [];
    expect(spawns.length).toBeGreaterThanOrEqual(3);

    // Importantly: every spawn was followed by an exit (the supervisor is
    // not stuck waiting for a child to come up).
    const exits = fullLog().match(/child pid=\d+ exited/g) ?? [];
    expect(exits.length, "every spawn should be paired with an exit log line").toBeGreaterThanOrEqual(spawns.length - 1);
  }, 8_000);

  it("coalesces a burst of file changes into a single restart (git-pull race)", async () => {
    await startSupervisor({
      cmd: ["bash", "-c", 'echo "child up"; trap "exit 0" TERM; while true; do sleep 1; done'],
      env: { DEV_API_DEBOUNCE_MS: "300", DEV_API_RESTART_MS: "300" },
    });
    await waitForLog((l) => /spawned pid=\d+/.test(l));

    // Write 16 files in rapid succession, mimicking a git pull bringing in
    // a multi-file PR.
    const burstDir = path.join(projectRoot, "src", "server", `__burst_${process.pid}`);
    await fs.mkdir(burstDir, { recursive: true });
    const filesToCleanup: string[] = [];
    for (let i = 0; i < 16; i++) {
      const f = path.join(burstDir, `f${i}.ts`);
      await fs.writeFile(f, `// burst ${i}`);
      filesToCleanup.push(f);
    }
    watchedFiles.push(...filesToCleanup);

    // Wait long enough for any belated change events to settle past the
    // debounce window.
    await new Promise((r) => setTimeout(r, 1500));

    const changeDetected = (fullLog().match(/change detected/g) ?? []).length;
    expect(changeDetected, "burst should coalesce into 1 (or at most 2) restart triggers").toBeLessThanOrEqual(2);
    expect(changeDetected, "but it must have triggered at least one").toBeGreaterThanOrEqual(1);

    // Cleanup the burst dir.
    await fs.rm(burstDir, { recursive: true, force: true });
  }, 15_000);

  it("ignores test files so editing a *.test.ts doesn't bounce the api", async () => {
    await startSupervisor({
      cmd: ["bash", "-c", 'echo "child up"; trap "exit 0" TERM; while true; do sleep 1; done'],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "200" },
    });
    await waitForLog((l) => /spawned pid=\d+/.test(l));
    const initialSpawns = (fullLog().match(/spawned pid=\d+/g) ?? []).length;

    // Write a TEST file under src/server — should NOT trigger a restart.
    await writeWatched(`src/server/__ignore.test_${process.pid}.test.ts`, "// test change");
    await new Promise((r) => setTimeout(r, 700));

    const laterSpawns = (fullLog().match(/spawned pid=\d+/g) ?? []).length;
    expect(laterSpawns).toBe(initialSpawns);
    expect(fullLog()).not.toMatch(/change detected/);
  }, 8_000);
});
