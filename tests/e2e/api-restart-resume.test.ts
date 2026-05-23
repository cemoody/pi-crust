import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { PiRpcAdapter } from "../../src/server/pi/pirpc-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { WorkerRegistry } from "../../src/server/session/worker-registry.js";
import { isPidAlive } from "../../src/server/session/worker-registry.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    try { await fn(); } catch {}
  }
});

const EXPECTED_TEXT = "alpha beta gamma delta epsilon zeta eta theta";
const CHUNKS = EXPECTED_TEXT.split(" ").map((w, i) => i === 0 ? w : " " + w);

async function makeFakePi(opts: { sessionId: string; deltaIntervalMs: number; }): Promise<{ root: string; executable: string; sessionFile: string; }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-e2e-restart-"));
  cleanups.push(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const sessionDir = path.join(root, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${opts.sessionId}.jsonl`);
  await fs.writeFile(sessionFile, "");
  const script = path.join(root, "fake-pi-rpc.mjs");
  await fs.writeFile(script, `
const sessionId = ${JSON.stringify(opts.sessionId)};
const sessionFile = ${JSON.stringify(sessionFile)};
const chunks = ${JSON.stringify(CHUNKS)};
const interval = ${opts.deltaIntervalMs};
let buf = "";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function state() { return { sessionId, sessionFile, isStreaming: false, isCompacting: false, messageCount: 0, model: { provider: "fake", id: "model" } }; }
async function runPrompt(reqId) {
  send({ id: reqId, type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });
  let acc = "";
  for (const c of chunks) {
    acc += c;
    send({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: acc }] }, assistantMessageEvent: { type: "text_delta", delta: c } });
    await new Promise((r) => setTimeout(r, interval));
  }
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: acc }] } });
  send({ type: "agent_end", messages: [{ role: "assistant", content: acc, timestamp: Date.now() }] });
}
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
    if (msg.type === "get_state") { send({ id: msg.id, type: "response", command: "get_state", success: true, data: state() }); continue; }
    if (msg.type === "get_messages") { send({ id: msg.id, type: "response", command: "get_messages", success: true, data: { messages: [] } }); continue; }
    if (msg.type === "get_session_stats") { send({ id: msg.id, type: "response", command: "get_session_stats", success: true, data: { tokens: { total: 0 } } }); continue; }
    if (msg.type === "prompt") { void runPrompt(msg.id); continue; }
    send({ id: msg.id, type: "response", command: msg.type, success: true });
  }
});
setInterval(() => {}, 60_000);
`);
  const exe = path.join(root, "fake-pi");
  await fs.writeFile(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`);
  await fs.chmod(exe, 0o755);
  return { root, executable: exe, sessionFile };
}

interface Stack {
  server: http.Server;
  registry: SessionRegistry;
  baseUrl: string;
}

async function startStack(opts: { runtimeDir: string; projectRoot: string; sessionRoot: string; piCommand: string; }): Promise<Stack> {
  const workerRegistry = new WorkerRegistry({ runtimeDir: opts.runtimeDir });
  const adapter = new PiRpcAdapter({ piCommand: opts.piCommand, sessionDir: opts.sessionRoot, runtimeDir: opts.runtimeDir, artifactExtension: false });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [opts.projectRoot], allowedSessionRoots: [opts.sessionRoot] }),
    workerRegistry,
  });
  const server = createHttpApiServer({
    registry,
    adapterKind: "pirpc",
    projectRoot: opts.projectRoot,
    sessionRoot: opts.sessionRoot,
    defaultCwd: opts.projectRoot,
  });
  const baseUrl = await listen(server);
  return { server, registry, baseUrl };
}

async function stopStack(stack: Stack, mode: "detach" | "dispose"): Promise<void> {
  if (mode === "detach") {
    await stack.registry.detachAll();
  } else {
    await stack.registry.disposeAll();
  }
  // Force-close all sockets (open SSE connections, etc.) so server.close resolves quickly.
  (stack.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => {
    let done = false;
    stack.server.close(() => { if (!done) { done = true; resolve(); } });
    setTimeout(() => { if (!done) { done = true; resolve(); } }, 1500).unref();
  });
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected TCP server");
  return `http://127.0.0.1:${addr.port}`;
}

interface ParsedSseEvent { id?: string; event?: string; data: string; }

class SseStream {
  private buffer = "";
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private queued: ParsedSseEvent[] = [];
  constructor(response: Response) {
    if (!response.body) throw new Error("no body");
    this.reader = response.body.getReader();
  }
  async next(timeoutMs = 5000): Promise<ParsedSseEvent> {
    if (this.queued.length > 0) return this.queued.shift()!;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = this.buffer.indexOf("\n\n");
      if (idx !== -1) {
        const raw = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const ev: ParsedSseEvent = { data: "" };
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("id:")) ev.id = line.slice(3).trim();
          else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        ev.data = dataLines.join("\n");
        if (!ev.data && !ev.event) continue;
        return ev;
      }
      const { value, done } = await Promise.race([
        this.reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) => setTimeout(() => resolve({ value: undefined, done: true }), Math.max(0, deadline - Date.now()))),
      ]);
      if (done) throw new Error("SSE stream closed");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
    throw new Error("SSE next() timed out");
  }
  cancel(): void { void this.reader.cancel().catch(() => {}); }
}

describe("API restart with detached workers", () => {
  it("preserves the worker, replays missed events to SSE, and yields the same final message as a no-restart control run", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-rt-"));
    cleanups.push(async () => { await fs.rm(runtimeDir, { recursive: true, force: true }); });
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-proj-"));
    cleanups.push(async () => { await fs.rm(projectRoot, { recursive: true, force: true }); });
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-sr-"));
    cleanups.push(async () => { await fs.rm(sessionRoot, { recursive: true, force: true }); });

    const log = (m: string) => { if (process.env.RESTART_DEBUG) console.log(`[t] ${m}`); };
    const fakePi = await makeFakePi({ sessionId: "restart-session", deltaIntervalMs: 60 });

    // ---- Control run: single API instance, no restart ----
    const controlStack = await startStack({ runtimeDir, projectRoot, sessionRoot, piCommand: fakePi.executable });
    const created = await postJson(`${controlStack.baseUrl}/api/sessions`, { cwd: projectRoot });
    const sessionId = (created as { id: string }).id;
    const sseControl = await openSse(`${controlStack.baseUrl}/api/sessions/${sessionId}/events`);
    await sseControl.next(); // ready
    const controlPrompt = postJson(`${controlStack.baseUrl}/api/sessions/${sessionId}/prompt`, { text: "go" });
    const controlDeltas: string[] = [];
    let controlAgentEnd = false;
    while (!controlAgentEnd) {
      const ev = await sseControl.next();
      const obj = JSON.parse(ev.data) as { type?: string; assistantMessageEvent?: { delta?: string } };
      if (obj.type === "message_update" && obj.assistantMessageEvent?.delta) controlDeltas.push(obj.assistantMessageEvent.delta);
      if (obj.type === "agent_end") controlAgentEnd = true;
    }
    await controlPrompt;
    sseControl.cancel();
    expect(controlDeltas.join("")).toBe(EXPECTED_TEXT);
    log("control done; disposing");
    await stopStack(controlStack, "dispose");

    // ---- Restart run: mid-stream API kill, then resume ----
    const runtimeDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-rt2-"));
    cleanups.push(async () => { await fs.rm(runtimeDir2, { recursive: true, force: true }); });
    const projectRoot2 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-proj2-"));
    cleanups.push(async () => { await fs.rm(projectRoot2, { recursive: true, force: true }); });
    const fakePi2 = await makeFakePi({ sessionId: "restart-session-2", deltaIntervalMs: 80 });
    // The fake pi writes its session file under fakePi2.root/sessions; align the
    // path-policy allowed session root accordingly.
    const sessionRoot2 = path.join(fakePi2.root, "sessions");

    log("restart: starting stack1");
    const stack1 = await startStack({ runtimeDir: runtimeDir2, projectRoot: projectRoot2, sessionRoot: sessionRoot2, piCommand: fakePi2.executable });
    log("restart: stack1 up; creating session");
    const created2 = await postJson(`${stack1.baseUrl}/api/sessions`, { cwd: projectRoot2 });
    const sid2 = (created2 as { id: string }).id;
    log(`restart: session ${sid2}`);

    const sse1 = await openSse(`${stack1.baseUrl}/api/sessions/${sid2}/events`);
    await sse1.next(); // ready
    // Fire the prompt but don't await — we'll kill the API before it returns.
    const prompt1 = fetch(`${stack1.baseUrl}/api/sessions/${sid2}/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "go" }),
    }).catch(() => undefined);

    // Read at least 2 deltas before killing.
    const earlyDeltas: string[] = [];
    let lastEventId: string | undefined;
    while (earlyDeltas.length < 2) {
      const ev = await sse1.next();
      if (ev.id) lastEventId = ev.id;
      const obj = JSON.parse(ev.data) as { type?: string; assistantMessageEvent?: { delta?: string } };
      if (obj.type === "message_update" && obj.assistantMessageEvent?.delta) earlyDeltas.push(obj.assistantMessageEvent.delta);
    }
    log(`restart: early deltas captured (${earlyDeltas.length}), lastEventId=${lastEventId}`);
    expect(lastEventId).toBeDefined();
    sse1.cancel();

    // Capture worker pid from the registry file so we can prove the process survived.
    const status = JSON.parse(await fs.readFile(path.join(runtimeDir2, "sessions", `${sid2}.json`), "utf8")) as { pid: number; lastSeq: number };
    expect(isPidAlive(status.pid)).toBe(true);

    // Simulate `kill <api-pid>`: SIGTERM-like cleanup (registry.detachAll) + close server.
    log("restart: detaching stack1");
    await stopStack(stack1, "detach");
    log("restart: stack1 detached");
    // Worker must still be alive.
    expect(isPidAlive(status.pid)).toBe(true);
    await prompt1; // swallow if it rejects

    // Start API #2 over the same runtime dir; it should auto-reattach.
    log("restart: starting stack2");
    const stack2 = await startStack({ runtimeDir: runtimeDir2, projectRoot: projectRoot2, sessionRoot: sessionRoot2, piCommand: fakePi2.executable });
    log("restart: reattaching");
    const reattached = await stack2.registry.reattachAll();
    log(`restart: reattached=${reattached.join(",")}`);
    expect(reattached).toContain(sid2);

    // Reconnect SSE with Last-Event-ID to replay missed events.
    const sse2 = await openSse(`${stack2.baseUrl}/api/sessions/${sid2}/events`, lastEventId);
    await sse2.next(); // ready
    const tailDeltas: string[] = [];
    let sawAgentEnd = false;
    let sawResync = false;
    while (!sawAgentEnd) {
      const ev = await sse2.next(10_000);
      if (ev.event === "session_resync") { sawResync = true; continue; }
      const obj = JSON.parse(ev.data) as { type?: string; assistantMessageEvent?: { delta?: string } };
      if (obj.type === "message_update" && obj.assistantMessageEvent?.delta) tailDeltas.push(obj.assistantMessageEvent.delta);
      if (obj.type === "agent_end") sawAgentEnd = true;
    }
    log(`restart: tail deltas captured (${tailDeltas.length}); sawResync=${sawResync}`);
    sse2.cancel();

    // Assemble: early + tail (no overlap since Last-Event-ID delivers seq > N).
    const combined = earlyDeltas.join("") + tailDeltas.join("");
    expect(combined).toBe(EXPECTED_TEXT);
    expect(sawResync).toBe(false);

    // Tear down: dispose this time (kills the worker).
    await stopStack(stack2, "dispose");
    // Allow some time for the supervisor to actually exit.
    await new Promise((r) => setTimeout(r, 200));
    expect(isPidAlive(status.pid)).toBe(false);
  }, 30_000);
});

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function openSse(url: string, lastEventId?: string): Promise<SseStream> {
  const headers: Record<string, string> = {};
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`SSE ${url} -> ${res.status}`);
  return new SseStream(res);
}
