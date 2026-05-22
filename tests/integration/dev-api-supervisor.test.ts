/**
 * Integration test for scripts/dev-api.mjs.
 *
 * These tests pin the invariants that distinguish this supervisor from
 * the old `tsx watch` default:
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
 *   4. SIGTERM on file-change kills the child's ENTIRE process group, not
 *      just the immediate child. The real-world consequence of getting
 *      this wrong: `npm run dev:api` is the immediate child, but doesn't
 *      forward SIGTERM to its sh→tsx→node descendants, so npm exits and
 *      orphans the actual http-api-server process. The orphan keeps
 *      holding port 8787, every subsequent respawn fails EADDRINUSE, the
 *      supervisor enters a permanent crash-loop. Observed in the wild on
 *      2026-05-15.
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

  it("SIGTERM on file change kills the child's whole process group (no orphaned grandchildren)", async () => {
    // Spawn a wrapper script that forks an inner child but does NOT forward
    // SIGTERM — the same behavior npm has by default. If our supervisor only
    // signaled the immediate child, the inner child would survive and keep
    // holding ports / file locks. The fix is `detached: true` + `kill(-pid)`.
    const wrapper = path.join(projectRoot, `__pgroup_wrapper_${process.pid}.sh`);
    await fs.writeFile(wrapper, [
      "#!/bin/bash",
      // inner child sleeps forever, ignoring SIGTERM. If only the wrapper
      // were signaled, this inner child would survive the restart.
      "bash -c 'trap : TERM; while true; do sleep 1; done' &",
      "inner=$!",
      "echo OUTER_PID=$$ INNER_PID=$inner",
      // Outer exits when its 'wait' is interrupted by a signal it doesn't
      // forward — mimicking npm's behavior on SIGTERM.
      "wait",
      "",
    ].join("\n"));
    await fs.chmod(wrapper, 0o755);
    watchedFiles.push(wrapper);

    await startSupervisor({
      cmd: [wrapper],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "300" },
    });
    await waitForLog((l) => /OUTER_PID=\d+ INNER_PID=\d+/.test(l));
    const m = fullLog().match(/OUTER_PID=(\d+) INNER_PID=(\d+)/);
    expect(m).toBeTruthy();
    const outerPid = m?.[1];
    const innerPid = m?.[2];
    expect(outerPid).toBeTruthy();
    expect(innerPid).toBeTruthy();

    // Trigger a watcher-driven restart.
    await writeWatched(`src/server/__pgroup_trigger_${process.pid}.ts`, "// change");
    await waitForLog((l) => /change detected/.test(l));
    // Give the supervisor's SIGTERM time to land on the group.
    await new Promise((r) => setTimeout(r, 1500));

    // BOTH the wrapper AND its inner grandchild should be gone.
    const isAlive = (pid: string | undefined) => {
      if (!pid) return false;
      try { process.kill(Number(pid), 0); return true; } catch { return false; }
    };
    expect(isAlive(outerPid), `outer pid ${outerPid} should be gone`).toBe(false);
    expect(isAlive(innerPid), `inner grandchild pid ${innerPid} should be gone (process-group kill)`).toBe(false);
  }, 12_000);

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

  it("survives a synchronous spawn() failure (ELOOP / ENOENT) and keeps retrying instead of crashing", async () => {
    // The exact failure mode observed on the dev box: a cyclic symlink in
    // node_modules (or any other broken binary lookup) makes spawn() throw
    // synchronously with ELOOP / ENOENT. Before this guard, the throw
    // escaped scripts/dev-api.mjs entirely and the whole npm-run-dev:api:loop
    // chain died with no respawn — the api stayed down indefinitely.
    //
    // We simulate by pointing the supervisor at a self-referencing symlink
    // (always ELOOP on resolve).
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-api-eloop-"));
    const cyclic = path.join(tmpDir, "loopme");
    await fs.symlink(cyclic, cyclic);
    try {
      await startSupervisor({
        cmd: [cyclic],
        env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "150" },
      });
      // Wait for at least 3 spawn attempts — we want to prove the
      // supervisor keeps looping rather than dying on the first throw.
      await waitForLog((l) => (l.match(/spawn\(\) threw synchronously/g) ?? []).length >= 3, 4_000);

      const throws = (fullLog().match(/spawn\(\) threw synchronously/g) ?? []).length;
      expect(throws).toBeGreaterThanOrEqual(3);

      // Crucially: the supervisor process itself must still be alive
      // and running, NOT exited from an unhandled exception. Test
      // afterEach kills it, so we just check the child handle.
      expect(supervisor?.killed).toBeFalsy();
      expect(supervisor?.exitCode).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});
