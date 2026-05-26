import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import type {
  CreateSessionOptions,
  ModelInfo,
  OpenSessionOptions,
  PiAdapter,
  PiEventListener,
  PiSessionHandle,
  PromptAttachment,
  SessionListItem,
  SessionMessage,
  SessionState,
  Unsubscribe,
} from "../../src/server/pi/types.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("HTTP API performance SLOs", () => {
  it("keeps polling endpoints bounded on a many-session, large-transcript corpus", async () => {
    const corpus = await makeCorpus({ count: 48, sizeBytes: 512_000 });

    await expectTimed("GET /api/health", 200, () => fetchJson(`${corpus.baseUrl}/api/health`));
    await expectTimed("GET /api/client-event/stats", 200, () => fetchJson(`${corpus.baseUrl}/api/client-event/stats`));
    const sessions = await expectTimed<Array<{ id: string }>>("cold GET /api/sessions", 1_500, () => fetchJson(`${corpus.baseUrl}/api/sessions?cwd=${encodeURIComponent(corpus.projectRoot)}`));
    expect(sessions).toHaveLength(48);

    const statuses = await expectTimed<Array<{ id: string }>>("cold GET /api/sessions/statuses", 1_500, () => fetchJson(`${corpus.baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(corpus.projectRoot)}`));
    expect(statuses).toHaveLength(48);

    await expectTimed("warm GET /api/sessions/statuses", 150, () => fetchJson(`${corpus.baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(corpus.projectRoot)}`));
  });

  it("dedupes concurrent list/status polling bursts instead of serializing full work", async () => {
    const corpus = await makeCorpus({ count: 64, sizeBytes: 256_000 });
    const urls = [
      "/api/sessions",
      "/api/sessions/statuses",
      "/api/sessions",
      "/api/sessions/statuses",
      "/api/sessions/statuses",
      "/api/sessions",
    ].map((route) => `${corpus.baseUrl}${route}?cwd=${encodeURIComponent(corpus.projectRoot)}`);

    await expectTimed("concurrent sidebar polling burst", 1_500, async () => {
      const responses = await Promise.all(urls.map((url) => fetch(url)));
      expect(responses.every((response) => response.ok)).toBe(true);
      await Promise.all(responses.map((response) => response.text()));
    });
  });
});

async function expectTimed<T>(label: string, maxMs: number, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  const elapsed = performance.now() - started;
  expect(elapsed, `${label} took ${Math.round(elapsed)}ms; budget ${maxMs}ms`).toBeLessThan(maxMs);
  return result;
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function makeCorpus(options: { readonly count: number; readonly sizeBytes: number }): Promise<{ readonly baseUrl: string; readonly projectRoot: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-api-slo-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const handles: SloHandle[] = [];
  for (let index = 0; index < options.count; index++) {
    const id = `slo-${String(index).padStart(3, "0")}`;
    const sessionFile = path.join(sessionRoot, `${id}.jsonl`);
    await fsp.writeFile(sessionFile, makeJsonl({ id, cwd: projectRoot, index, sizeBytes: options.sizeBytes }), "utf8");
    handles.push(new SloHandle({ id, cwd: projectRoot, sessionFile, lastActivity: 1_700_000_000_000 + index }));
  }
  const adapter = new SloAdapter(handles);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  return { baseUrl: await listen(server), projectRoot };
}

function makeJsonl(options: { readonly id: string; readonly cwd: string; readonly index: number; readonly sizeBytes: number }): string {
  const header = JSON.stringify({ type: "session", id: options.id, cwd: options.cwd, timestamp: 1_700_000_000_000 + options.index }) + "\n";
  const user = JSON.stringify({ type: "message", message: { role: "user", content: "hello", timestamp: 1_700_000_000_100 + options.index } }) + "\n";
  const filler = JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(400), timestamp: 1_700_000_000_200 + options.index } }) + "\n";
  return header + user + filler.repeat(Math.ceil(Math.max(0, options.sizeBytes - header.length - user.length) / filler.length));
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server did not bind to TCP"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

class SloAdapter implements PiAdapter {
  constructor(private readonly handles: readonly SloHandle[]) {}
  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    const handle = this.handles[0];
    if (!handle) throw new Error("no sessions");
    if (options.sessionName !== undefined) handle.sessionName = options.sessionName;
    return handle;
  }
  async openSession(options: OpenSessionOptions): Promise<PiSessionHandle> {
    const handle = this.handles.find((candidate) => candidate.sessionFile === options.sessionFile);
    if (!handle) throw new Error(`unknown session ${options.sessionFile}`);
    return handle;
  }
  async listSessions(): Promise<readonly SessionListItem[]> {
    return this.handles.map((handle) => ({
      id: handle.id,
      cwd: handle.cwd,
      sessionFile: handle.sessionFile,
      ...(handle.sessionName === undefined ? {} : { sessionName: handle.sessionName }),
      lastActivity: handle.lastActivity,
    }));
  }
  async listModels(): Promise<readonly ModelInfo[]> { return [{ provider: "test", id: "slo", name: "SLO", available: true }]; }
}

class SloHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly lastActivity: number;
  sessionName: string | undefined;
  private readonly emitter = new EventEmitter();
  constructor(options: { readonly id: string; readonly cwd: string; readonly sessionFile: string; readonly lastActivity: number }) {
    this.id = options.id; this.cwd = options.cwd; this.sessionFile = options.sessionFile; this.lastActivity = options.lastActivity;
  }
  async getState(): Promise<SessionState> { return { id: this.id, cwd: this.cwd, sessionFile: this.sessionFile, status: "idle", messageCount: 0, lastActivity: this.lastActivity, ...(this.sessionName === undefined ? {} : { sessionName: this.sessionName }) }; }
  async getMessages(): Promise<readonly SessionMessage[]> { return []; }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}
