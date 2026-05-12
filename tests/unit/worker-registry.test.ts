import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerRegistry, isPidAlive } from "../../src/server/session/worker-registry.js";

const createdDirs: string[] = [];
afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeRuntime(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rc-worker-reg-"));
  createdDirs.push(dir);
  return dir;
}

describe("WorkerRegistry", () => {
  it("returns alive workers and prunes dead-pid status files", async () => {
    const runtimeDir = await makeRuntime();
    const registry = new WorkerRegistry({ runtimeDir });
    await registry.ensureDirs();

    // A live worker: use the test process pid (clearly alive).
    const aliveStatus = {
      pid: process.pid,
      sessionId: "alive-session",
      socketPath: path.join(registry.sessionsDir, "alive-session.sock"),
      sessionFile: path.join(runtimeDir, "alive.jsonl"),
      cwd: runtimeDir,
      lastSeq: 7,
    };
    await fs.writeFile(registry.statusPath("alive-session"), JSON.stringify(aliveStatus));
    // Create a corresponding (empty) socket file so we can verify it survives.
    await fs.writeFile(aliveStatus.socketPath, "");

    // A dead worker: spawn a quick child, get pid, wait for it to exit.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Sanity: confirm we observe the process as dead.
    expect(isPidAlive(deadPid)).toBe(false);
    const deadStatus = {
      pid: deadPid,
      sessionId: "dead-session",
      socketPath: path.join(registry.sessionsDir, "dead-session.sock"),
      sessionFile: path.join(runtimeDir, "dead.jsonl"),
      cwd: runtimeDir,
      lastSeq: 0,
    };
    await fs.writeFile(registry.statusPath("dead-session"), JSON.stringify(deadStatus));
    await fs.writeFile(deadStatus.socketPath, "");

    // A corrupt status file: should be removed.
    await fs.writeFile(path.join(registry.sessionsDir, "garbage.json"), "{not valid json");

    const alive = await registry.listAlive();
    expect(alive.map((w) => w.sessionId)).toEqual(["alive-session"]);

    // Dead status file pruned.
    await expect(fs.access(registry.statusPath("dead-session"))).rejects.toThrow();
    await expect(fs.access(deadStatus.socketPath)).rejects.toThrow();
    // Live status file retained.
    await expect(fs.access(registry.statusPath("alive-session"))).resolves.toBeUndefined();
    await expect(fs.access(aliveStatus.socketPath)).resolves.toBeUndefined();
    // Garbage removed.
    await expect(fs.access(path.join(registry.sessionsDir, "garbage.json"))).rejects.toThrow();
  });

  it("isPidAlive treats finite alive pids true and zero/negative false", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});
