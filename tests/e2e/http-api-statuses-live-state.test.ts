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

describe("GET /api/sessions/statuses live-state overlay", () => {
  it("does not let an unhealthy hot session block the sidebar status snapshot", async () => {
    const mounted = await mountHotStatusServer([
      { id: "fast-a", mode: "fast", status: "running" },
      { id: "broken", mode: "never", healthy: false, status: "running" },
      { id: "fast-b", mode: "fast", status: "idle" },
    ]);

    const started = performance.now();
    const response = await fetchWithTimeout(`${mounted.baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(mounted.projectRoot)}`, 1_200);
    const elapsedMs = performance.now() - started;

    expect(response.ok).toBe(true);
    const cards = await response.json() as Array<{ id: string; status: string }>;
    expect(cards.map((card) => card.id).sort()).toEqual(["broken", "fast-a", "fast-b"]);
    expect(cards.find((card) => card.id === "fast-a")?.status).toBe("streaming");
    // The broken row should degrade to the persisted list-card instead of
    // waiting forever for getState() on a stale supervisor socket.
    expect(cards.find((card) => card.id === "broken")?.status).toBe("idle");
    expect(elapsedMs).toBeLessThan(750);
  });

  it("bounds live getState fan-out when hot supervisors accept but never answer", async () => {
    const mounted = await mountHotStatusServer([
      ...Array.from({ length: 8 }, (_, index) => ({ id: `hung-${index}`, mode: "never" as const, status: "running" as const })),
      { id: "fast", mode: "fast", status: "idle" },
    ]);

    const started = performance.now();
    const response = await fetchWithTimeout(`${mounted.baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(mounted.projectRoot)}`, 1_500);
    const elapsedMs = performance.now() - started;

    expect(response.ok).toBe(true);
    const cards = await response.json() as Array<{ id: string }>;
    expect(cards).toHaveLength(9);
    // The timeout must apply per request fan-out, not sequentially per hot
    // session. Without a bounded live-state overlay this request never
    // resolves and the AbortController above fails the test.
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

interface HotSessionSpec {
  readonly id: string;
  readonly mode: "fast" | "never";
  readonly healthy?: boolean;
  readonly status: SessionState["status"];
}

async function mountHotStatusServer(specs: readonly HotSessionSpec[]): Promise<{ baseUrl: string; projectRoot: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-statuses-hot-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });

  const handles: HotStatusHandle[] = [];
  for (const spec of specs) {
    const sessionFile = path.join(sessionRoot, `${spec.id}.jsonl`);
    await fsp.writeFile(sessionFile, JSON.stringify({ type: "session", id: spec.id, cwd: projectRoot, timestamp: 1_700_000_000_000 }) + "\n", "utf8");
    handles.push(new HotStatusHandle({ ...spec, cwd: projectRoot, sessionFile }));
  }

  const adapter = new HotStatusAdapter(handles);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  for (const handle of handles) {
    await registry.openSession(handle.sessionFile);
  }

  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  return { baseUrl: await listen(server), projectRoot };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

class HotStatusAdapter implements PiAdapter {
  constructor(private readonly handles: readonly HotStatusHandle[]) {}
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
    return this.handles.map((handle, index) => ({
      id: handle.id,
      cwd: handle.cwd,
      sessionFile: handle.sessionFile,
      ...(handle.sessionName === undefined ? {} : { sessionName: handle.sessionName }),
      createdAt: 1_700_000_000_000 + index,
      lastActivity: 1_700_000_000_000 + index,
    }));
  }
  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "hot", name: "Hot", available: true }];
  }
}

class HotStatusHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  sessionName: string | undefined;
  private readonly mode: HotSessionSpec["mode"];
  private readonly healthy: boolean;
  private readonly status: SessionState["status"];
  private readonly emitter = new EventEmitter();

  constructor(options: HotSessionSpec & { readonly cwd: string; readonly sessionFile: string }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sessionFile = options.sessionFile;
    this.mode = options.mode;
    this.healthy = options.healthy ?? true;
    this.status = options.status;
  }

  isHealthy(): boolean { return this.healthy; }

  async getState(): Promise<SessionState> {
    if (this.mode === "never") return new Promise<SessionState>(() => {});
    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      status: this.status,
      ...(this.sessionName === undefined ? {} : { sessionName: this.sessionName }),
      messageCount: 0,
      lastActivity: 1_700_000_000_000,
    };
  }

  async getMessages(): Promise<readonly SessionMessage[]> { return []; }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}
