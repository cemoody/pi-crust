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
import { PtyManager, type PtyChild, type PtySpawnOptions } from "../../src/server/pty/pty-manager.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

export interface RealtimeHarness {
  readonly baseUrl: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly registry: SessionRegistry;
  readonly adapter: RealtimeTestAdapter;
  readonly server: http.Server;
  createSession(options?: { readonly id?: string; readonly cwd?: string; readonly ringSize?: number }): Promise<RealtimeTestSessionHandle>;
  /** Create a session through the real HTTP route so the server records its
   *  cold-session file mapping (the path getOrOpenSession uses to reopen a
   *  disk-resident session). */
  createSessionViaHttp(options?: { readonly cwd?: string }): Promise<{ readonly id: string }>;
  /** Drop a session from the hot registry while keeping its file + cold
   *  mapping, so a later subscribe must reopen it from disk. */
  coolSession(id: string): Promise<void>;
  dispose(): Promise<void>;
}

/** In-memory fake pty: deterministic, no real shell. Echoes a synthetic prompt
 *  on open and a line of output per input so the e2e suite can assert ordered,
 *  lossless streaming over the real socket without timing flakiness. */
class FakePtyChild implements PtyChild {
  readonly pid = Math.floor(Math.random() * 1e6);
  private dataListeners = new Set<(d: string) => void>();
  private exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();
  constructor(_o: PtySpawnOptions) { setTimeout(() => this.emit("$ "), 0); }
  write(data: string): void {
    const cmd = data.replace(/[\r\n]+$/, "");
    if (/^burst (\d+)/.test(cmd)) {
      const n = Number(/^burst (\d+)/.exec(cmd)![1]);
      for (let i = 1; i <= n; i += 1) this.emit(`line ${i}\r\n`);
      this.emit("$ ");
      return;
    }
    this.emit(`${cmd}\r\n$ `);
  }
  resize(): void { /* no-op */ }
  onData(l: (d: string) => void): () => void { this.dataListeners.add(l); return () => this.dataListeners.delete(l); }
  onExit(l: (e: { exitCode: number; signal?: number }) => void): () => void { this.exitListeners.add(l); return () => this.exitListeners.delete(l); }
  kill(): void { for (const l of [...this.exitListeners]) l({ exitCode: 0, signal: 0 }); }
  private emit(d: string): void { for (const l of [...this.dataListeners]) l(d); }
}

export async function createRealtimeHarness(options: { readonly eventRingSize?: number; readonly withPty?: boolean } = {}): Promise<RealtimeHarness> {
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
  const ptyManager = options.withPty ? new PtyManager({ spawn: (o) => new FakePtyChild(o) }) : undefined;
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot, ...(ptyManager ? { ptyManager } : {}) });
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
    async createSessionViaHttp(createOptions = {}) {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: createOptions.cwd ?? projectRoot }),
      });
      if (!response.ok) throw new Error(`createSessionViaHttp failed: ${response.status}`);
      const card = await response.json();
      return { id: card.id as string };
    },
    async coolSession(id) {
      await registry.disposeSession(id);
    },
    async dispose() {
      ptyManager?.disposeAll();
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

// ---- Shared Socket.IO client helpers --------------------------------------
// A durable `session:event` listener is attached at connect time and pushes
// into a per-socket queue. This avoids the classic EventEmitter race where an
// event arriving while only a transient `once` listener exists (or none) is
// silently dropped.

const REALTIME_TIMEOUT = Symbol("realtime-timeout");

export interface RealtimeSocket {
  readonly socket: any;
  readonly queue: any[];
  readonly ptyData: any[];
  readonly ptyExits: any[];
  subscribe(sessionId: string, fromSeq: number | null): Promise<any>;
  unsubscribe(sessionId: string): Promise<any>;
  nextEvent(sessionId: string, predicate?: (event: any) => boolean): Promise<any>;
  noEvent(timeoutMs: number): Promise<boolean>;
  noEventWithSeq(seq: number, timeoutMs: number): Promise<boolean>;
  ptyOpen(sessionId: string, cols?: number, rows?: number): Promise<any>;
  ptyInput(ptyId: string, data: string): Promise<any>;
  ptyText(ptyId: string): string;
  waitPtyData(ptyId: string, predicate: (text: string) => boolean, timeoutMs?: number): Promise<void>;
  disconnect(): void;
  close(): void;
}

export async function connectRealtimeSocket(baseUrl: string): Promise<RealtimeSocket> {
  const { io } = await import("socket.io-client") as any;
  const socket = io(baseUrl, { path: "/socket.io/", transports: ["websocket"], reconnection: false, timeout: 1_000 });
  const queue: any[] = [];
  const ptyData: any[] = [];
  const ptyExits: any[] = [];
  socket.on("session:event", (event: any) => { queue.push(event); });
  socket.on("pty:data", (event: any) => { ptyData.push(event); });
  socket.on("pty:exit", (event: any) => { ptyExits.push(event); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Socket.IO realtime transport")), 1_500);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", (error: unknown) => { clearTimeout(timer); reject(error); });
  });

  const emitWithAck = (event: string, payload: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} ack`)), 1_000);
    socket.emit(event, payload, (ack: unknown) => { clearTimeout(timer); resolve(ack); });
  });

  return {
    socket,
    queue,
    ptyData,
    ptyExits,
    subscribe: (sessionId, fromSeq) => emitWithAck("session:subscribe", { sessionId, fromSeq }),
    unsubscribe: (sessionId) => emitWithAck("session:unsubscribe", { sessionId }),
    ptyOpen: (sessionId, cols = 80, rows = 24) => emitWithAck("pty:open", { sessionId, cols, rows }),
    ptyInput: (ptyId, data) => emitWithAck("pty:input", { ptyId, data }),
    ptyText(ptyId) { return ptyData.filter((e) => e.ptyId === ptyId).map((e) => e.data).join(""); },
    async waitPtyData(ptyId, predicate, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = ptyData.filter((e) => e.ptyId === ptyId).map((e) => e.data).join("");
        if (predicate(text)) return;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for pty:data on ${ptyId}; got: ${JSON.stringify(text)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async nextEvent(sessionId, predicate = () => true) {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const index = queue.findIndex((event) => event.sessionId === sessionId && predicate(event));
        if (index !== -1) return queue.splice(index, 1)[0];
        if (Date.now() > deadline) throw new Error(`Timed out waiting for session:event for ${sessionId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async noEvent(timeoutMs) {
      const before = queue.length;
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return queue.length === before;
    },
    async noEventWithSeq(seq, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (queue.some((event) => event.seq === seq)) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return !queue.some((event) => event.seq === seq);
    },
    disconnect() { try { socket.disconnect(); } catch { /* ignore */ } },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

export { REALTIME_TIMEOUT };

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
