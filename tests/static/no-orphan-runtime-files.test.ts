/**
 * Static-ish check: when a pirpc-supervisor is started against a fake
 * pi, then SIGTERM'd, the supervisor MUST remove its UDS socket file
 * AND its status JSON file from --runtime-dir on exit. Anything else
 * leaks files into the runtime dir and confuses the next supervisor's
 * duplicate-detection logic.
 *
 * Counted as "static" because the test asserts a basic invariant of
 * file management, not a behavioral scenario.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeFakePi } from "../helpers/fake-pi.js";
import { waitFor, isAlive } from "../helpers/process-tree.js";

const supervisorScript = path.resolve(__dirname, "..", "..", "scripts", "pirpc-supervisor.mjs");
const cleanups: Array<() => Promise<void> | void> = [];
const procs: ChildProcess[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) { try { p.kill("SIGKILL"); } catch { /* ignore */ } }
  for (const c of cleanups.splice(0)) { try { await c(); } catch { /* ignore */ } }
});

describe("static: pirpc-supervisor leaves no runtime files on clean shutdown", () => {
  it("SIGTERM \u2192 status file and socket file are removed", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-cleanup-"));
    cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const fakePi = await makeFakePi({ sessionId: "cleanup-test-session" });
    cleanups.push(fakePi.cleanup);

    const token = `tok-${process.pid}`;
    const proc = spawn(process.execPath, [
      supervisorScript,
      "--command", fakePi.executable,
      "--cwd", os.tmpdir(),
      "--args", "[]",
      "--runtime-dir", runtimeDir,
      "--worker-token", token,
    ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    proc.unref();
    procs.push(proc);

    // Wait for the supervisor to publish its status + socket.
    const sessionsDir = path.join(runtimeDir, "sessions");
    const socketDir = path.join(runtimeDir, "s");
    await waitFor(async () => {
      try {
        const sessions = await fs.readdir(sessionsDir);
        const sockets = await fs.readdir(socketDir);
        return sessions.length > 0 && sockets.length > 0;
      } catch { return false; }
    }, { timeoutMs: 5000, label: "runtime files present" });

    proc.kill("SIGTERM");
    await waitFor(() => !isAlive(proc.pid!), { timeoutMs: 5000, label: "supervisor exited" });

    // Both directories should be empty.
    const sessionsAfter = await fs.readdir(sessionsDir).catch(() => []);
    const socketsAfter = await fs.readdir(socketDir).catch(() => []);
    expect(sessionsAfter, "no status files should remain").toEqual([]);
    expect(socketsAfter, "no UDS socket files should remain").toEqual([]);
  }, 15_000);
});
