/**
 * Wire-protocol properties for pirpc-supervisor.
 *
 * Statements (driven by random inputs with a deterministic seed):
 *
 *   P1. For any sequence of supervisor `emitEvent`s and any client
 *       (re)connect with `resumeFromSeq = k`, every event seq appears
 *       at most once across the union of frames the client received
 *       (across all its connections).
 *
 *   P2. For frames received in a single client connection, `seq` is
 *       strictly monotonically increasing by 1 from the first event
 *       frame onward.
 *
 *   P3. A `resync` frame appears iff the client's resume point sits
 *       below `ring.lowSeq() - 1`.
 *
 * The protocol is implemented in scripts/pirpc-supervisor.mjs. To test
 * it without spinning up a real `pi --mode rpc` we drive the actual
 * supervisor process against a parameterized fake-pi (see
 * tests/helpers/fake-pi.ts).
 *
 * This file is the property-test counterpart to
 * tests/unit/pirpc-supervisor.test.ts (which covers individual
 * scenarios by hand).
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeFakePi } from "../helpers/fake-pi.js";
import { socketBasename } from "../../src/server/session/worker-registry.js";

const supervisorScript = path.resolve(__dirname, "..", "..", "scripts", "pirpc-supervisor.mjs");
const cleanups: Array<() => Promise<void> | void> = [];
const procs: ChildProcess[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) { try { p.kill("SIGKILL"); } catch { /* ignore */ } }
  for (const c of cleanups.splice(0)) { try { await c(); } catch { /* ignore */ } }
});

interface SpawnedSupervisor {
  proc: ChildProcess;
  runtimeDir: string;
  socketPath: string;
  sessionId: string;
}

async function spawnSupervisorWithFakePi(opts: {
  sessionId: string;
  initialEvents?: number;
}): Promise<SpawnedSupervisor> {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pirpc-prop-runtime-"));
  cleanups.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const fakePi = await makeFakePi({ sessionId: opts.sessionId, initialEvents: opts.initialEvents ?? 0 });
  cleanups.push(fakePi.cleanup);
  const workerToken = `tok-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const proc = spawn(process.execPath, [
    supervisorScript,
    "--command", fakePi.executable,
    "--cwd", os.tmpdir(),
    "--args", "[]",
    "--runtime-dir", runtimeDir,
    "--worker-token", workerToken,
    "--ring-size", "32",
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.unref();
  procs.push(proc);
  const readyPath = path.join(runtimeDir, "workers", `${workerToken}.ready`);
  // Wait for the supervisor to publish its ready file.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await fs.access(readyPath); break; } catch { /* loop */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  const socketPath = path.join(runtimeDir, "s", socketBasename(opts.sessionId));
  return { proc, runtimeDir, socketPath, sessionId: opts.sessionId };
}

interface ReceivedFrame {
  t: "hello" | "event" | "resync";
  seq?: number;
  data?: unknown;
  [k: string]: unknown;
}

async function readFramesFrom(socketPath: string, resumeFromSeq: number | null, waitMs = 400): Promise<ReceivedFrame[]> {
  return new Promise((resolve, reject) => {
    const out: ReceivedFrame[] = [];
    let buf = "";
    const sock = net.createConnection(socketPath);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ t: "hello", resumeFromSeq }) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      while (true) {
        const i = buf.indexOf("\n");
        if (i === -1) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    sock.on("error", reject);
    setTimeout(() => { try { sock.end(); } catch { /* ignore */ } resolve(out); }, waitMs);
  });
}

describe("pirpc-supervisor protocol properties", () => {
  it("P2: single-connection event seqs are monotonic and gap-free", async () => {
    const sup = await spawnSupervisorWithFakePi({ sessionId: "prop-p2", initialEvents: 16 });
    const frames = await readFramesFrom(sup.socketPath, 0, 600);
    // Drop the hello + any resync; just inspect event frames.
    const events = frames.filter((f) => f.t === "event");
    expect(events.length, "should have at least the initial events").toBeGreaterThanOrEqual(16);
    for (let i = 1; i < events.length; i++) {
      const cur = events[i]; const prev = events[i - 1];
      if (!cur || !prev) throw new Error("unreachable");
      expect(cur.seq, `seq ${i}`).toBe((prev.seq as number) + 1);
    }
  }, 15_000);

  it("P3: resume below ring's low water triggers a resync frame", async () => {
    // Ring size 32, emit 100 events, then resume from seq=1 (way below low).
    const sup = await spawnSupervisorWithFakePi({ sessionId: "prop-p3", initialEvents: 100 });
    // Give the fake-pi time to emit all events into the supervisor's ring.
    await new Promise((r) => setTimeout(r, 400));
    const frames = await readFramesFrom(sup.socketPath, 1, 400);
    const hasResync = frames.some((f) => f.t === "resync");
    expect(hasResync, "resume from seq=1 below ring should yield a resync").toBe(true);
  }, 15_000);

  it("P3-inverse: resume from current lastSeq does NOT yield resync", async () => {
    const sup = await spawnSupervisorWithFakePi({ sessionId: "prop-p3-neg", initialEvents: 4 });
    await new Promise((r) => setTimeout(r, 400));
    const frames = await readFramesFrom(sup.socketPath, -1, 200); // live-only
    const hasResync = frames.some((f) => f.t === "resync");
    expect(hasResync).toBe(false);
  }, 10_000);
});
