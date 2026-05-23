import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { socketBasename } from "../../src/server/session/worker-registry.js";

const supervisorScript = path.resolve(__dirname, "../../scripts/pirpc-supervisor.mjs");
const tmpDirs: string[] = [];
const procs: ChildProcess[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    try { p.kill("SIGKILL"); } catch {}
  }
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeFakePi(opts: { initialEvents?: number; sessionId?: string }): Promise<{ runtime: string; executable: string; }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-supervisor-"));
  tmpDirs.push(root);
  const sessionId = opts.sessionId ?? "supervisor-test-session";
  const sessionFile = path.join(root, `${sessionId}.jsonl`);
  await fs.writeFile(sessionFile, "");
  const initial = opts.initialEvents ?? 0;
  const script = path.join(root, "fake-pi-rpc.mjs");
  await fs.writeFile(script, `
import fs from "node:fs";
let sessionId = ${JSON.stringify(sessionId)};
let sessionFile = ${JSON.stringify(sessionFile)};
let buf = "";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function state() { return { sessionId, sessionFile, isStreaming: false, isCompacting: false, messageCount: 0, model: { provider: "fake", id: "model" } }; }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (true) {
    const i = buf.indexOf("\\n");
    if (i === -1) return;
    const line = buf.slice(0, i).replace(/\\r$/, "");
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "get_state") {
      send({ id: msg.id, type: "response", command: "get_state", success: true, data: state() });
      continue;
    }
    if (msg.type === "emit_test_event") {
      send({ id: msg.id, type: "response", command: "emit_test_event", success: true });
      for (let i = 0; i < msg.count; i++) send({ type: "fake_event", n: msg.start + i });
      continue;
    }
    if (msg.type === "switch_identity") {
      sessionId = msg.sessionId;
      sessionFile = ${JSON.stringify(root)} + "/" + sessionId + ".jsonl";
      fs.writeFileSync(sessionFile, "");
      send({ id: msg.id, type: "response", command: "switch_identity", success: true });
      continue;
    }
    send({ id: msg.id, type: "response", command: msg.type, success: true });
  }
});
// Emit initial unsolicited events so the ring has content before any client connects.
setTimeout(() => { for (let i = 1; i <= ${initial}; i++) send({ type: "fake_event", n: i }); }, 50);
// Stay alive.
setInterval(() => {}, 60_000);
`, "utf8");
  const exe = path.join(root, "fake-pi");
  await fs.writeFile(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`);
  await fs.chmod(exe, 0o755);
  return { runtime: root, executable: exe };
}

function startSupervisor(opts: { fakeExe: string; cwd: string; runtimeDir: string; workerToken: string; ringSize?: number; }): ChildProcess {
  const args = [
    supervisorScript,
    "--command", opts.fakeExe,
    "--cwd", opts.cwd,
    "--args", JSON.stringify(["--mode", "rpc"]),
    "--runtime-dir", opts.runtimeDir,
    "--worker-token", opts.workerToken,
  ];
  if (opts.ringSize) { args.push("--ring-size", String(opts.ringSize)); }
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], detached: false });
  procs.push(child);
  return child;
}

async function waitForReady(file: string, timeoutMs = 5000): Promise<{ sessionId: string; socketPath: string; pid: number; }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(text);
      if (parsed && parsed.sessionId && parsed.socketPath) return parsed;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("supervisor never wrote ready file");
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`file never appeared: ${file}`);
}

interface Frame { t: string; [k: string]: unknown; }

class LineSocket {
  readonly frames: Frame[] = [];
  private buf = "";
  constructor(public socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buf += chunk;
      while (true) {
        const i = this.buf.indexOf("\n");
        if (i === -1) break;
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        try { this.frames.push(JSON.parse(line)); } catch {}
      }
    });
  }
  send(obj: unknown): void { this.socket.write(JSON.stringify(obj) + "\n"); }
  async waitFor(predicate: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out waiting for frame; saw: " + JSON.stringify(this.frames).slice(0, 500));
  }
  async waitForCount(predicate: (f: Frame) => boolean, count: number, timeoutMs = 3000): Promise<Frame[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.filter(predicate);
      if (found.length >= count) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${count} frames`);
  }
  end(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.end();
      setTimeout(() => { try { this.socket.destroy(); } catch {} resolve(); }, 300).unref();
    });
  }
}

async function connectClient(socketPath: string): Promise<LineSocket> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ path: socketPath });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  return new LineSocket(socket);
}

describe("pirpc-supervisor", () => {
  it("buffers events while no client is connected and replays them on resume without duplication", async () => {
    const { runtime, executable } = await makeFakePi({ initialEvents: 5 });
    const runtimeDir = path.join(runtime, "rt");
    const sup = startSupervisor({ fakeExe: executable, cwd: runtime, runtimeDir, workerToken: "tok-1" });

    const ready = await waitForReady(path.join(runtimeDir, "workers", "tok-1.ready"));
    expect(ready.sessionId).toBe("supervisor-test-session");

    // First connection: ask for full ring (resumeFromSeq: 0) and expect 5 fake events.
    const client1 = await connectClient(ready.socketPath);
    client1.send({ t: "hello", resumeFromSeq: 0 });
    const ack1 = await client1.waitFor((f) => f.t === "hello") as Frame & { lastSeq: number };
    expect(ack1.sessionId).toBe("supervisor-test-session");
    const first5 = await client1.waitForCount((f) => f.t === "event" && (f.data as any)?.type === "fake_event", 5);
    expect(first5.map((f) => (f.data as any).n)).toEqual([1, 2, 3, 4, 5]);
    const seqAt5 = (first5[4] as any).seq as number;

    // Request 3 more events while connected.
    client1.send({ t: "rpc", data: { id: "r1", type: "emit_test_event", start: 6, count: 3 } });
    const through8 = await client1.waitForCount((f) => f.t === "event" && (f.data as any)?.type === "fake_event", 8);
    expect(through8.map((f) => (f.data as any).n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const seqAt8 = (through8[7] as any).seq as number;
    expect(seqAt8).toBeGreaterThan(seqAt5);

    // Disconnect.
    await client1.end();

    // While disconnected, ask the fake child to emit 4 more events via a second short-lived client.
    // We use a fresh connection to send a single rpc and then immediately close.
    const pulser = await connectClient(ready.socketPath);
    pulser.send({ t: "hello", resumeFromSeq: -1 });
    await pulser.waitFor((f) => f.t === "hello");
    pulser.send({ t: "rpc", data: { id: "r2", type: "emit_test_event", start: 9, count: 4 } });
    // Wait for the response so we know the fake child has received the rpc.
    await pulser.waitFor((f) => f.t === "event" && (f.data as any)?.type === "response" && (f.data as any)?.id === "r2");
    // Wait until the supervisor has processed the 4 new events too.
    await pulser.waitForCount((f) => f.t === "event" && (f.data as any)?.type === "fake_event", 4);
    await pulser.end();

    // Reconnect with resumeFromSeq = seqAt8. Should get only events 9..12 with seq > seqAt8, no dupes.
    const client2 = await connectClient(ready.socketPath);
    client2.send({ t: "hello", resumeFromSeq: seqAt8 });
    await client2.waitFor((f) => f.t === "hello");
    const replayed = await client2.waitForCount((f) => f.t === "event" && (f.data as any)?.type === "fake_event", 4);
    expect(replayed.map((f) => (f.data as any).n)).toEqual([9, 10, 11, 12]);
    // No event has seq <= seqAt8.
    for (const f of replayed) expect((f as any).seq).toBeGreaterThan(seqAt8);
    // No duplicate seq numbers.
    const seqs = replayed.map((f) => (f as any).seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    await client2.end();

    // Shutdown the supervisor cleanly.
    const shutter = await connectClient(ready.socketPath);
    shutter.send({ t: "hello", resumeFromSeq: -1 });
    await shutter.waitFor((f) => f.t === "hello");
    shutter.send({ t: "shutdown" });
    await new Promise<void>((resolve) => sup.once("exit", () => resolve()));
  });

  it("emits a resync frame when client resumes from before the ring window", async () => {
    const { runtime, executable } = await makeFakePi({ initialEvents: 0 });
    const runtimeDir = path.join(runtime, "rt");
    const sup = startSupervisor({ fakeExe: executable, cwd: runtime, runtimeDir, workerToken: "tok-2", ringSize: 3 });
    const ready = await waitForReady(path.join(runtimeDir, "workers", "tok-2.ready"));

    // Push 10 events through (ring size 3 means seqs 1..7 are evicted).
    const c = await connectClient(ready.socketPath);
    c.send({ t: "hello", resumeFromSeq: -1 });
    await c.waitFor((f) => f.t === "hello");
    c.send({ t: "rpc", data: { id: "x", type: "emit_test_event", start: 1, count: 10 } });
    await c.waitForCount((f) => f.t === "event" && (f.data as any)?.type === "fake_event", 10);
    await c.end();

    // Reconnect asking from seq=1 which is far behind the ring's low.
    const c2 = await connectClient(ready.socketPath);
    c2.send({ t: "hello", resumeFromSeq: 1 });
    await c2.waitFor((f) => f.t === "hello");
    const resync = await c2.waitFor((f) => f.t === "resync");
    expect(typeof (resync as any).ringLowSeq).toBe("number");
    expect((resync as any).ringLowSeq).toBeGreaterThan(1);
    await c2.end();

    try { sup.kill("SIGTERM"); } catch {}
    await new Promise<void>((resolve) => { sup.once("exit", () => resolve()); setTimeout(resolve, 1500).unref(); });
  });

  it("moves its runtime status and listening socket when the child switches session identity", async () => {
    const { runtime, executable } = await makeFakePi({ initialEvents: 0, sessionId: "original-session" });
    const runtimeDir = path.join(runtime, "rt");
    const sup = startSupervisor({ fakeExe: executable, cwd: runtime, runtimeDir, workerToken: "tok-move" });
    const ready = await waitForReady(path.join(runtimeDir, "workers", "tok-move.ready"));
    expect(ready.sessionId).toBe("original-session");
    const oldStatus = path.join(runtimeDir, "sessions", "original-session.json");
    const oldSocket = path.join(runtimeDir, "s", socketBasename("original-session"));
    const newStatus = path.join(runtimeDir, "sessions", "forked-session.json");
    const newSocket = path.join(runtimeDir, "s", socketBasename("forked-session"));
    await expect(fs.access(oldStatus)).resolves.toBeUndefined();
    await expect(fs.access(oldSocket)).resolves.toBeUndefined();

    const client = await connectClient(ready.socketPath);
    client.send({ t: "hello", resumeFromSeq: -1 });
    await client.waitFor((f) => f.t === "hello");
    client.send({ t: "rpc", data: { id: "switch", type: "switch_identity", sessionId: "forked-session" } });
    await client.waitFor((f) => f.t === "event" && (f.data as any)?.type === "response" && (f.data as any)?.id === "switch");
    client.send({ t: "rpc", data: { id: "state-after-switch", type: "get_state" } });
    await client.waitFor((f) => f.t === "event" && (f.data as any)?.type === "response" && (f.data as any)?.id === "state-after-switch");

    await waitForFile(newStatus);
    await waitForFile(newSocket);
    await expect(fs.access(oldStatus)).rejects.toThrow();
    await expect(fs.access(oldSocket)).rejects.toThrow();
    const moved = JSON.parse(await fs.readFile(newStatus, "utf8"));
    expect(moved).toMatchObject({ sessionId: "forked-session", socketPath: newSocket, pid: ready.pid });

    const newClient = await connectClient(newSocket);
    newClient.send({ t: "hello", resumeFromSeq: -1 });
    const newAck = await newClient.waitFor((f) => f.t === "hello");
    expect((newAck as { sessionId?: string }).sessionId).toBe("forked-session");
    await newClient.end();
    await client.end();

    try { sup.kill("SIGTERM"); } catch {}
    await new Promise<void>((resolve) => { sup.once("exit", () => resolve()); setTimeout(resolve, 1500).unref(); });
  });

  /**
   * Regression: when a second supervisor is spawned for a sessionId that
   * already has a live supervisor (a real-world race between the api's
   * reattach and a concurrent openSession call), the duplicate MUST NOT
   * exit silently — the spawning adapter is blocking on `${token}.ready`
   * and would otherwise fail with ENOENT. Instead, the duplicate writes its
   * own .ready file pointing at the EXISTING supervisor's socket, marked
   * `redirected: true`, so the adapter transparently connects to the
   * already-running supervisor.
   *
   * Previously regressed once already after a refactor; this test pins it.
   */
  it("duplicate supervisor for the same session writes a redirect .ready file pointing at the live supervisor's socket", async () => {
    const { runtime, executable } = await makeFakePi({ initialEvents: 0, sessionId: "shared-session" });
    const runtimeDir = path.join(runtime, "rt");

    // First supervisor: claims the session.
    const supA = startSupervisor({ fakeExe: executable, cwd: runtime, runtimeDir, workerToken: "tok-A" });
    const readyA = await waitForReady(path.join(runtimeDir, "workers", "tok-A.ready"));
    expect(readyA.sessionId).toBe("shared-session");

    // Second supervisor for the same session: should detect supA, write a
    // redirect ready file, and exit cleanly.
    const supB = startSupervisor({ fakeExe: executable, cwd: runtime, runtimeDir, workerToken: "tok-B" });
    const readyB = await waitForReady(path.join(runtimeDir, "workers", "tok-B.ready"));

    // Redirect points at A's socket and is flagged as redirected.
    expect(readyB.socketPath).toBe(readyA.socketPath);
    expect((readyB as { redirected?: boolean }).redirected).toBe(true);
    expect(readyB.pid).toBe(readyA.pid);

    // supB should terminate on its own; supA should still be serving.
    await new Promise<void>((resolve) => { supB.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
    expect(supB.killed || typeof supB.exitCode === "number").toBe(true);
    expect(supA.exitCode).toBeNull();

    // A's socket is still functional: a fresh client can hello/handshake.
    const client = await connectClient(readyA.socketPath);
    client.send({ t: "hello", resumeFromSeq: null });
    const ack = await client.waitFor((f) => f.t === "hello");
    expect((ack as { sessionId?: string }).sessionId).toBe("shared-session");
    await client.end();

    try { supA.kill("SIGTERM"); } catch {}
    await new Promise<void>((resolve) => { supA.once("exit", () => resolve()); setTimeout(resolve, 1500).unref(); });
  });
});
