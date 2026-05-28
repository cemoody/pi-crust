import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import type {
  CreateSessionOptions,
  ModelInfo,
  OpenSessionOptions,
  PiAdapter,
  PiEvent,
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

export interface RealtimeHarness {
  readonly baseUrl: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly registry: SessionRegistry;
  readonly adapter: RealtimeTestAdapter;
  readonly server: http.Server;
  createSession(options?: { readonly id?: string; readonly cwd?: string; readonly ringSize?: number }): Promise<RealtimeTestSessionHandle>;
  dispose(): Promise<void>;
}

export async function createRealtimeHarness(options: { readonly eventRingSize?: number } = {}): Promise<RealtimeHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-realtime-test-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });

  const adapter = new RealtimeTestAdapter(sessionRoot);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    ...(options.eventRingSize === undefined ? {} : { eventRingSize: options.eventRingSize }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    projectRoot,
    sessionRoot,
    registry,
    adapter,
    server,
    async createSession(createOptions = {}) {
      const created = await registry.createSession({
        cwd: createOptions.cwd ?? projectRoot,
        ...(createOptions.id === undefined ? {} : { sessionName: createOptions.id }),
      });
      return adapter.requireSession(created.id);
    },
    async dispose() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await registry.disposeAll().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export class RealtimeTestAdapter implements PiAdapter {
  private readonly sessions = new Map<string, RealtimeTestSessionHandle>();
  private nextId = 1;

  constructor(private readonly sessionRoot: string) {}

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    const requestedName = options.sessionName?.trim();
    const id = requestedName && /^[a-zA-Z0-9_.:-]+$/.test(requestedName) ? requestedName : `realtime-session-${this.nextId++}`;
    const session = new RealtimeTestSessionHandle({
      id,
      cwd: path.resolve(options.cwd),
      sessionFile: path.join(this.sessionRoot, `${id}.jsonl`),
    });
    this.sessions.set(session.id, session);
    return session;
  }

  async openSession(options: OpenSessionOptions): Promise<PiSessionHandle> {
    const existing = [...this.sessions.values()].find((session) => session.sessionFile === options.sessionFile);
    if (!existing) throw new Error(`No session for file: ${options.sessionFile}`);
    return existing;
  }

  async listSessions(cwd?: string): Promise<readonly SessionListItem[]> {
    return [...this.sessions.values()]
      .filter((session) => !cwd || path.resolve(session.cwd) === path.resolve(cwd))
      .map((session) => ({ id: session.id, cwd: session.cwd, sessionFile: session.sessionFile, lastActivity: session.lastActivity }));
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "realtime", name: "Realtime", available: true }];
  }

  requireSession(id: string): RealtimeTestSessionHandle {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown test session: ${id}`);
    return session;
  }
}

export class RealtimeTestSessionHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  lastActivity = Date.now();
  private readonly emitter = new EventEmitter();
  private messages: SessionMessage[] = [];
  private status: SessionState["status"] = "idle";
  private promptGate: Promise<void> | null = null;

  constructor(options: { readonly id: string; readonly cwd: string; readonly sessionFile: string }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sessionFile = options.sessionFile;
  }

  async getState(): Promise<SessionState> {
    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      status: this.status,
      messageCount: this.messages.length,
      totalTokens: 0,
      lastActivity: this.lastActivity,
    };
  }

  async getMessages(): Promise<readonly SessionMessage[]> {
    return [...this.messages];
  }

  async prompt(message: string, _attachments?: readonly PromptAttachment[]): Promise<void> {
    this.status = "running";
    this.lastActivity = Date.now();
    this.emit({ type: "agent_start" });
    this.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: `delta:${message}` },
    });
    if (this.promptGate) await this.promptGate;
    const now = Date.now();
    this.messages = [
      { role: "user", content: message, timestamp: now },
      { role: "assistant", content: `done:${message}`, timestamp: now + 1 },
    ];
    this.status = "idle";
    this.lastActivity = now + 1;
    this.emit({ type: "agent_end", messages: this.messages });
  }

  gateNextPrompt(gate: Promise<void>): void {
    this.promptGate = gate.finally(() => { this.promptGate = null; });
  }

  emitTestEvent(event: PiEvent): void {
    this.emit(event);
  }

  async abort(): Promise<void> {
    this.status = "idle";
    this.emit({ type: "agent_end", messages: this.messages });
  }

  async setSessionName(_name: string): Promise<SessionState> {
    return this.getState();
  }

  async setModel(_provider: string, _modelId: string): Promise<SessionState> {
    return this.getState();
  }

  subscribe(listener: PiEventListener): Unsubscribe {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async dispose(): Promise<void> {
    this.emitter.removeAllListeners();
  }

  private emit(event: PiEvent): void {
    this.lastActivity = Date.now();
    this.emitter.emit("event", event);
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor<T>(producer: () => T | undefined | null | false, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = producer();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
