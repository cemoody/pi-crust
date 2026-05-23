/**
 * 2026-05-23 — 147 orphaned pirpc-supervisor.mjs processes (~16 GB RSS).
 *
 * Symptom: every dev-api restart that didn't cleanly re-adopt its
 * existing per-session supervisors left them dangling with PPID=1. Over
 * 9 days this accumulated to 147 processes consuming ~16 GB of RSS,
 * none of which were doing useful work — their UDS sockets were either
 * stale or pointed at a long-dead API.
 *
 * Post-mortem in: docs/incidents.md (2026-05-23)
 *
 * Invariants we now enforce:
 *
 *   1. When a supervisor has no client and the status-file owner has
 *      been gone for `PIRPC_ABANDONMENT_TIMEOUT_S`, it self-exits.
 *   2. A periodic reaper (separate utility, scripts/reap-supervisors.mjs)
 *      can identify orphan supervisors by:
 *        - PPID=1, AND
 *        - status-file ownership pid is not alive, AND
 *        - no client connection on its UDS socket
 *      and SIGTERM them.
 *   3. The reaper is idempotent and safe to run alongside a live API.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { makeFakePi } from "../helpers/fake-pi.js";
import { isAlive, waitFor } from "../helpers/process-tree.js";

const supervisorScript = path.resolve(__dirname, "..", "..", "scripts", "pirpc-supervisor.mjs");
const reaperScript = path.resolve(__dirname, "..", "..", "scripts", "reap-supervisors.mjs");

const cleanups: Array<() => Promise<void> | void> = [];
const childProcs: ChildProcess[] = [];

afterEach(async () => {
  for (const proc of childProcs.splice(0)) {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  }
  for (const c of cleanups.splice(0)) { try { await c(); } catch { /* ignore */ } }
});

async function spawnSupervisor(opts: {
  runtimeDir: string;
  pi: { executable: string };
  workerToken?: string;
}): Promise<ChildProcess> {
  const token = opts.workerToken ?? `tok-${process.pid}-${childProcs.length}`;
  const proc = spawn(process.execPath, [
    supervisorScript,
    "--command", opts.pi.executable,
    "--cwd", os.tmpdir(),
    "--args", JSON.stringify([]),
    "--runtime-dir", opts.runtimeDir,
    "--worker-token", token,
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.unref();
  childProcs.push(proc);
  return proc;
}

describe("2026-05-23 orphan supervisor leak", () => {
  it("scripts/reap-supervisors.mjs identifies and SIGTERMs orphan supervisors", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "reap-test-runtime-"));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));

    // Spawn a real supervisor over a fake pi. Wait for it to write its
    // status file (proof it's healthy), then write a stale status file
    // claiming ownership by a long-dead pid to make it look orphaned.
    const fakePi = await makeFakePi({ sessionId: "reap-test-session" });
    cleanups.push(fakePi.cleanup);
    const sup = await spawnSupervisor({ runtimeDir, pi: fakePi });
    cleanups.push(() => { try { sup.kill("SIGKILL"); } catch { /* ignore */ } });

    // Wait for the supervisor to bind its socket + write its status file.
    const sessionsDir = path.join(runtimeDir, "sessions");
    await waitFor(async () => {
      try { return (await fs.readdir(sessionsDir)).length > 0; } catch { return false; }
    }, { timeoutMs: 5000, label: "supervisor status file" });

    // Spawn the reaper with a "real-pid filter" env that tells it to
    // treat *only* a sentinel pid (pid 99999999 — not alive) as the
    // "live API" — so our supervisor's parent (us) doesn't shield it.
    const reaperProc = spawn(process.execPath, [reaperScript], {
      env: {
        ...process.env,
        PIRPC_REAPER_RUNTIME_DIR: runtimeDir,
        PIRPC_REAPER_LIVE_API_PIDS: "99999999",
        PIRPC_REAPER_DRY_RUN: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const reaperOut: string[] = [];
    reaperProc.stdout?.on("data", (c) => reaperOut.push(c.toString()));
    reaperProc.stderr?.on("data", (c) => reaperOut.push(c.toString()));
    await new Promise<void>((resolve) => reaperProc.once("exit", () => resolve()));

    // The supervisor we spawned should be SIGTERM'd by the reaper.
    await waitFor(() => !isAlive(sup.pid!), { timeoutMs: 5000, label: "supervisor reaped" });
    expect(isAlive(sup.pid!)).toBe(false);
    expect(reaperOut.join("")).toMatch(/reaped|terminated|sent SIGTERM/i);
  }, 20_000);

  it("reaper is idempotent: running twice on no orphans is a no-op", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "reap-noop-"));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    await fs.mkdir(path.join(runtimeDir, "sessions"), { recursive: true });
    await fs.mkdir(path.join(runtimeDir, "s"), { recursive: true });
    await fs.mkdir(path.join(runtimeDir, "workers"), { recursive: true });

    const run = async () => {
      const out: string[] = [];
      const proc = spawn(process.execPath, [reaperScript], {
        env: { ...process.env, PIRPC_REAPER_RUNTIME_DIR: runtimeDir, PIRPC_REAPER_DRY_RUN: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout?.on("data", (c) => out.push(c.toString()));
      proc.stderr?.on("data", (c) => out.push(c.toString()));
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      return { code: proc.exitCode, out: out.join("") };
    };

    const a = await run();
    const b = await run();
    expect(a.code, "first run exit code").toBe(0);
    expect(b.code, "second run exit code").toBe(0);
    expect(a.out + b.out).toMatch(/0 orphans|no orphans|nothing to reap/i);
  }, 15_000);

  it("reaper dry-run does not kill anything", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "reap-dry-"));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const fakePi = await makeFakePi({ sessionId: "reap-dry-session" });
    cleanups.push(fakePi.cleanup);
    const sup = await spawnSupervisor({ runtimeDir, pi: fakePi });

    await waitFor(async () => {
      try { return (await fs.readdir(path.join(runtimeDir, "sessions"))).length > 0; }
      catch { return false; }
    }, { timeoutMs: 5000, label: "status file" });

    const proc = spawn(process.execPath, [reaperScript], {
      env: {
        ...process.env,
        PIRPC_REAPER_RUNTIME_DIR: runtimeDir,
        PIRPC_REAPER_LIVE_API_PIDS: "99999999",
        PIRPC_REAPER_DRY_RUN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    proc.stdout?.on("data", (c) => out.push(c.toString()));
    proc.stderr?.on("data", (c) => out.push(c.toString()));
    await new Promise<void>((resolve) => proc.once("exit", () => resolve()));

    expect(out.join(""), "dry-run must mark as would-reap, not actually reap").toMatch(/would (reap|terminate|kill)/i);
    expect(isAlive(sup.pid!), "supervisor must still be alive after dry-run").toBe(true);
  }, 15_000);
});
