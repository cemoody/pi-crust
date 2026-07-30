import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { TranscriptTailWorkerPool } from "../../src/server/session/transcript-tail-worker-pool.js";
import type { CreateSessionOptions, ModelInfo, OpenSessionOptions, PiAdapter, PiEventListener, PiSessionHandle, PromptAttachment, SessionListItem, SessionMessage, SessionState, Unsubscribe } from "../../src/server/pi/types.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];
const pools: TranscriptTailWorkerPool[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("heavy transcript tail worker", () => {
  it("keeps health responsive while giant JSONL parsing is off-thread, unlike the blocking fallback", async () => {
    const worker = await startServer(1);
    const workerTail = fetch(`${worker.url}/api/sessions/heavy/messages?limit=200`);
    await worker.workerStarted;
    const workerHealthMs = await latency(`${worker.url}/api/health`);
    expect((await workerTail).ok).toBe(true);

    const fallback = await startServer(0);
    const fallbackTail = fetch(`${fallback.url}/api/sessions/heavy/messages?limit=200`);
    await fallback.mainThreadParseStarted;
    const fallbackHealthMs = await latency(`${fallback.url}/api/health`);
    expect((await fallbackTail).ok).toBe(true);

    // Worker parsing has begun but cannot monopolize the HTTP event loop. The
    // local fallback deliberately yields to the health request then burns CPU,
    // making the contrast deterministic rather than hardware-dependent.
    expect(workerHealthMs).toBeLessThan(100);
    expect(fallbackHealthMs).toBeGreaterThan(120);
    expect(fallbackHealthMs).toBeGreaterThan(workerHealthMs * 3);
    console.info(`[tail-worker benchmark] health: worker=${workerHealthMs.toFixed(1)}ms, blocking=${fallbackHealthMs.toFixed(1)}ms (${(fallbackHealthMs / workerHealthMs).toFixed(1)}x faster)`);
  });

  it("caps concurrent workers and falls back without changing parsed output", async () => {
    const server = await startServer(1);
    // Start the first request and wait until it has occupied the only worker.
    // Subsequent distinct cursor keys bypass the page cache and must take the
    // bounded local fallback rather than queuing behind an unbounded pool.
    const first = fetch(`${server.url}/api/sessions/heavy/messages?limit=5`);
    await server.workerStarted;
    const excess = await Promise.all([1, 2].map((before) => fetch(`${server.url}/api/sessions/heavy/messages?limit=5&before=${before}`)));
    const responses = [await first, ...excess];
    expect(responses.every((response) => response.ok)).toBe(true);
    await Promise.all(responses.map((response) => response.json()));
    // maxWorkers=1 means the concurrent excess took the synchronous fallback,
    // proving requests are never queued behind an unbounded worker pool.
    expect(server.mainThreadParses).toBeGreaterThan(0);
    expect(server.pool.activeWorkers).toBe(0);
  });
});

async function startServer(maxWorkers: number) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-tail-worker-")); roots.push(root);
  const projectRoot = path.join(root, "project"); const sessionRoot = path.join(root, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true }); await fsp.mkdir(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, "heavy.jsonl");
  const line = JSON.stringify({ type: "message", timestamp: Date.now(), message: { role: "assistant", content: "x".repeat(16_000) } }) + "\n";
  await fsp.writeFile(sessionFile, JSON.stringify({ type: "session", id: "heavy", cwd: projectRoot }) + "\n" + line.repeat(180), "utf8");
  let workerStartedResolve!: () => void; const workerStarted = new Promise<void>((resolve) => { workerStartedResolve = resolve; });
  let parseStartedResolve!: () => void; const mainThreadParseStarted = new Promise<void>((resolve) => { parseStartedResolve = resolve; });
  let mainThreadParses = 0;
  const pool = new TranscriptTailWorkerPool({ minBytes: 1, maxWorkers, onWorkerStarted: workerStartedResolve, onMainThreadParseStart: () => { mainThreadParses++; parseStartedResolve(); setImmediate(() => burnCpu(180)); } }); pools.push(pool);
  const handle = new Handle(sessionFile, projectRoot);
  const registry = new SessionRegistry({ adapter: new Adapter(handle), pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }) });
  await registry.createSession({ cwd: projectRoot });
  const httpServer = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, transcriptTailWorkers: pool }); servers.push(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address(); if (!address || typeof address === "string") throw new Error("server did not bind");
  return { url: `http://127.0.0.1:${address.port}`, workerStarted, mainThreadParseStarted, pool, get mainThreadParses() { return mainThreadParses; } };
}

function burnCpu(ms: number) { const end = performance.now() + ms; while (performance.now() < end) JSON.parse('{"x":"' + "x".repeat(10_000) + '"}'); }
async function latency(url: string) {
  const start = performance.now();
  await new Promise<void>((resolve, reject) => http.get(url, (response) => {
    response.resume(); response.once("end", resolve);
  }).once("error", reject));
  return performance.now() - start;
}

class Adapter implements PiAdapter {
  constructor(private readonly handle: Handle) {} async createSession(_: CreateSessionOptions) { return this.handle; } async openSession(_: OpenSessionOptions) { return this.handle; }
  async listSessions(): Promise<readonly SessionListItem[]> { return [{ id: this.handle.id, cwd: this.handle.cwd, sessionFile: this.handle.sessionFile, lastActivity: 0 }]; }
  async listModels(): Promise<readonly ModelInfo[]> { return []; }
}
class Handle implements PiSessionHandle {
  readonly id = "heavy"; private readonly emitter = new EventEmitter(); constructor(readonly sessionFile: string, readonly cwd: string) {}
  async getState(): Promise<SessionState> { return { id: this.id, cwd: this.cwd, sessionFile: this.sessionFile, status: "idle", messageCount: 0, lastActivity: 0 }; }
  async getMessages(): Promise<readonly SessionMessage[]> { throw new Error("tail reader should parse this file"); } async prompt(_: string, _a: readonly PromptAttachment[] = []) {} async abort() {}
  async setSessionName(_: string) { return this.getState(); } async setModel(_: string, _m: string) { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); } async dispose() {}
}
