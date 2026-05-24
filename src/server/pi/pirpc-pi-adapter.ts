import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUiResponse } from "../../shared/protocol.js";
import type {
  CloneSessionResult,
  CreateSessionOptions,
  ForkMessage,
  ForkSessionResult,
  ModelInfo,
  OpenSessionOptions,
  PiAdapter,
  PiEvent,
  PiEventListener,
  PiSessionHandle,
  PromptAttachment,
  ReattachSessionOptions,
  SessionListItem,
  SessionMessage,
  SessionState,
  SeqEventListener,
  Unsubscribe,
} from "./types.js";
import { WorkerRegistry } from "../session/worker-registry.js";

export interface PiRpcAdapterOptions {
  readonly sessionDir?: string;
  readonly piCommand?: string;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
  readonly runtimeDir?: string;
  readonly supervisorScript?: string;
}

interface RpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command?: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

interface PendingRequest {
  readonly resolve: (value: RpcResponse) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Pi adapter backed by detached `pi --mode rpc` workers.
 *
 * Each hot session corresponds to a long-lived `scripts/pirpc-supervisor.mjs`
 * subprocess (spawned detached, stdio="ignore", unref()) that owns the real
 * pi child's stdio and exposes a Unix-domain-socket JSONL transport. When
 * the API server restarts the workers keep running; the new API instance
 * reads ${runtimeDir}/sessions/*.json (via WorkerRegistry) and reattaches.
 */
export class PiRpcAdapter implements PiAdapter {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly piCommand: string;
  private readonly workerRegistry: WorkerRegistry;
  private readonly supervisorScript: string;

  constructor(private readonly options: PiRpcAdapterOptions = {}) {
    this.piCommand = options.piCommand ?? resolvePiCommand();
    this.workerRegistry = new WorkerRegistry(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir });
    this.supervisorScript = options.supervisorScript ?? resolveSupervisorScript();
  }

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    const handle = await PiRpcSessionHandle.spawn({
      cwd: path.resolve(options.cwd),
      piCommand: this.piCommand,
      supervisorScript: this.supervisorScript,
      workerRegistry: this.workerRegistry,
      ...(this.options.sessionDir === undefined ? {} : { sessionDir: this.options.sessionDir }),
      ...(this.options.extraArgs === undefined ? {} : { extraArgs: this.options.extraArgs }),
      ...(this.options.artifactExtension === undefined ? {} : { artifactExtension: this.options.artifactExtension }),
    });
    if (options.sessionName) await handle.setSessionName(options.sessionName);
    return handle;
  }

  async openSession(options: OpenSessionOptions): Promise<PiSessionHandle> {
    const sessionFile = path.resolve(options.sessionFile);
    const cwd = await findSessionCwd(sessionFile, this.options.sessionDir) ?? process.cwd();
    return PiRpcSessionHandle.spawn({
      cwd,
      sessionFile,
      piCommand: this.piCommand,
      supervisorScript: this.supervisorScript,
      workerRegistry: this.workerRegistry,
      ...(this.options.sessionDir === undefined ? {} : { sessionDir: this.options.sessionDir }),
      ...(this.options.extraArgs === undefined ? {} : { extraArgs: this.options.extraArgs }),
      ...(this.options.artifactExtension === undefined ? {} : { artifactExtension: this.options.artifactExtension }),
    });
  }

  async reattachSession(options: ReattachSessionOptions): Promise<PiSessionHandle> {
    return PiRpcSessionHandle.reattach({
      sessionId: options.sessionId,
      socketPath: options.socketPath,
      sessionFile: options.sessionFile,
      cwd: options.cwd,
      workerRegistry: this.workerRegistry,
    });
  }

  async forkSession(source: PiSessionHandle, entryId: string): Promise<{ readonly result: ForkSessionResult; readonly handle: PiSessionHandle }> {
    if (!(source instanceof PiRpcSessionHandle)) throw new Error("PiRpcAdapter can only fork Pi RPC sessions");
    const sourceManager = SessionManager.open(source.sessionFile, this.options.sessionDir);
    const selectedEntry = sourceManager.getEntry(entryId) as any;
    if (!selectedEntry) throw new Error("Invalid entry ID for forking");
    if (selectedEntry.type !== "message" || selectedEntry.message?.role !== "user") {
      throw new Error("Invalid entry ID for forking");
    }
    const selectedText = userMessageText(selectedEntry.message.content);
    let forkedSessionFile: string | undefined;
    if (selectedEntry.parentId) {
      forkedSessionFile = sourceManager.createBranchedSession(String(selectedEntry.parentId));
      if (forkedSessionFile) await ensureSessionManagerFileExists(sourceManager, forkedSessionFile);
    } else {
      const sessionManager = SessionManager.create(source.cwd, this.options.sessionDir);
      forkedSessionFile = sessionManager.newSession({ parentSession: source.sessionFile });
      if (forkedSessionFile) await ensureSessionManagerFileExists(sessionManager, forkedSessionFile);
    }
    if (!forkedSessionFile) throw new Error("Failed to create forked session");
    const handle = await PiRpcSessionHandle.spawn({
      cwd: source.cwd,
      sessionFile: forkedSessionFile,
      piCommand: this.piCommand,
      supervisorScript: this.supervisorScript,
      workerRegistry: this.workerRegistry,
      ...(this.options.sessionDir === undefined ? {} : { sessionDir: this.options.sessionDir }),
      ...(this.options.extraArgs === undefined ? {} : { extraArgs: this.options.extraArgs }),
      ...(this.options.artifactExtension === undefined ? {} : { artifactExtension: this.options.artifactExtension }),
    });
    return { result: { cancelled: false, text: selectedText }, handle };
  }

  async listSessions(cwd?: string): Promise<readonly SessionListItem[]> {
    // We used to call SessionManager.list(cwd, sessionDir) here, but that
    // function reads the FULL body of every session jsonl just to compute
    // sidebar metadata (messageCount, allMessagesText, etc. — most of which
    // we throw away). For a 232 MB / 200-file corpus that single call cost
    // several seconds of synchronous CPU per /statuses request, and
    // serialized concurrent /statuses requests behind it.
    //
    // Everything we actually need is at the file's edges:
    //   - id, cwd, createdAt  → the first `type:"session"` line
    //   - firstMessage        → first user message, typically near the top
    //   - sessionName         → most recent `session_info` entry, also rare
    //                           and usually near the top of the file
    //   - lastActivity        → most recent timestamp in the tail; falls
    //                           back to stat.mtime when missing
    // So we do a bounded head+tail scan per file in parallel and skip the
    // SDK helper entirely.
    return fastListSessions(this.options.sessionDir, cwd);
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const available = await this.modelRegistry.getAvailable();
    return available.map((model: any) => ({
      provider: String(model.provider ?? ""),
      id: String(model.id ?? ""),
      name: String(model.name ?? model.id ?? "unknown"),
      available: true,
    }));
  }
}

interface SpawnSessionOptions {
  readonly cwd: string;
  readonly sessionFile?: string;
  readonly sessionDir?: string;
  readonly piCommand: string;
  readonly supervisorScript: string;
  readonly workerRegistry: WorkerRegistry;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
}

interface ReattachInternalOptions {
  readonly sessionId: string;
  readonly socketPath: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly workerRegistry: WorkerRegistry;
}

class PiRpcSessionHandle implements PiSessionHandle {
  id: string;
  cwd: string;
  sessionFile: string;

  private readonly rpc: SupervisedRpcProcess;
  private readonly emitter = new EventEmitter();
  private readonly seqEmitter = new EventEmitter();
  private latestState: Record<string, unknown>;
  private disposed = false;
  private detached = false;

  private constructor(rpc: SupervisedRpcProcess, cwd: string, state: Record<string, unknown>) {
    this.rpc = rpc;
    this.cwd = cwd;
    this.latestState = state;
    this.id = String(state.sessionId ?? "");
    this.sessionFile = String(state.sessionFile ?? "");
    if (!this.id) throw new Error("Pi RPC session did not report a sessionId");
    if (!this.sessionFile) throw new Error("Pi RPC session did not report a sessionFile");

    this.rpc.onEvent((event, seq) => {
      this.emitter.emit("event", event as PiEvent);
      this.seqEmitter.emit("event", event as PiEvent, seq);
    });
  }

  static async spawn(options: SpawnSessionOptions): Promise<PiRpcSessionHandle> {
    const args = ["--mode", "rpc"];
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.sessionFile) args.push("--session", options.sessionFile);
    const extension = await resolveArtifactExtension(options.artifactExtension);
    if (extension) args.push("--extension", extension);
    // Also load @cemoody/pi-artifact (registers the `display` tool for
    // multi-MIME inline artifacts: image/HTML/Vega-Lite/Plotly). It's an
    // optional npm dep — if not installed (or explicitly disabled), we
    // skip it silently and pi continues with just the built-in tool.
    const cemoodyExtension = await resolveCemoodyArtifactExtension();
    if (cemoodyExtension) args.push("--extension", cemoodyExtension);
    args.push(...(options.extraArgs ?? []));

    const rpc = await SupervisedRpcProcess.spawnDetached({
      piCommand: options.piCommand,
      args,
      cwd: options.cwd,
      supervisorScript: options.supervisorScript,
      workerRegistry: options.workerRegistry,
    });
    try {
      const state = await rpc.request("get_state");
      if (!isRecord(state)) throw new Error("Pi RPC get_state returned invalid data");
      return new PiRpcSessionHandle(rpc, options.cwd, state);
    } catch (error) {
      await rpc.dispose();
      throw error;
    }
  }

  static async reattach(options: ReattachInternalOptions): Promise<PiRpcSessionHandle> {
    const rpc = await SupervisedRpcProcess.connect({
      socketPath: options.socketPath,
      // After API restart we want the supervisor to replay its full ring so
      // SSE clients reconnecting to the new API process can be backfilled.
      resumeFromSeq: 0,
    });
    const state = await rpc.request("get_state");
    if (!isRecord(state)) {
      await rpc.detach();
      throw new Error("Pi RPC get_state returned invalid data during reattach");
    }
    return new PiRpcSessionHandle(rpc, options.cwd, state);
  }

  async getState(): Promise<SessionState> {
    const data = await this.rpc.request("get_state");
    if (!isRecord(data)) throw new Error("Pi RPC get_state returned invalid data");
    this.latestState = data;
    const stats = await this.getSessionStats();
    return this.toState(data, stats);
  }

  async getMessages(): Promise<readonly SessionMessage[]> {
    const data = await this.rpc.request("get_messages");
    const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
    return toSessionMessages(messages);
  }

  async prompt(message: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    const images = attachments
      .filter((attachment) => attachment.type === "image" && attachment.data)
      .map((attachment) => ({
        type: "image" as const,
        data: attachment.data!,
        mimeType: attachment.mimeType ?? "image/png",
      }));
    const waitForEnd = this.waitForAgentEnd();
    await this.rpc.request("prompt", {
      message,
      ...(images.length > 0 ? { images } : {}),
    });
    await waitForEnd;
  }

  async abort(): Promise<void> {
    await this.rpc.request("abort");
  }

  async setSessionName(name: string): Promise<SessionState> {
    await this.rpc.request("set_session_name", { name });
    return this.getState();
  }

  async setModel(provider: string, modelId: string): Promise<SessionState> {
    await this.rpc.request("set_model", { provider, modelId });
    return this.getState();
  }

  async getForkMessages(): Promise<readonly ForkMessage[]> {
    const data = await this.rpc.request("get_fork_messages");
    const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
    return messages
      .filter((message): message is Record<string, unknown> => isRecord(message) && typeof message.entryId === "string" && typeof message.text === "string")
      .map((message) => ({ entryId: String(message.entryId), text: String(message.text) }));
  }

  async fork(entryId: string): Promise<ForkSessionResult> {
    const data = await this.rpc.request("fork", { entryId });
    const result = parseForkResult(data);
    if (!result.cancelled) await this.refreshIdentity();
    return result;
  }

  async clone(): Promise<CloneSessionResult> {
    const data = await this.rpc.request("clone");
    const result = parseCloneResult(data);
    if (!result.cancelled) await this.refreshIdentity();
    return result;
  }

  async respondToExtensionUi(response: ExtensionUiResponse): Promise<void> {
    this.rpc.send({ type: "extension_ui_response", ...response });
  }

  subscribe(listener: PiEventListener): Unsubscribe {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  subscribeWithSeq(listener: SeqEventListener): Unsubscribe {
    this.seqEmitter.on("event", listener);
    return () => this.seqEmitter.off("event", listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.emitter.removeAllListeners();
    this.seqEmitter.removeAllListeners();
    await this.rpc.dispose();
  }

  async detach(): Promise<void> {
    if (this.disposed || this.detached) return;
    this.detached = true;
    this.emitter.removeAllListeners();
    this.seqEmitter.removeAllListeners();
    await this.rpc.detach();
  }

  private async refreshIdentity(): Promise<void> {
    const data = await this.rpc.request("get_state");
    if (!isRecord(data)) throw new Error("Pi RPC get_state returned invalid data");
    this.latestState = data;
    this.id = String(data.sessionId ?? "");
    this.sessionFile = String(data.sessionFile ?? "");
    this.cwd = String(data.cwd ?? this.cwd);
    if (!this.id) throw new Error("Pi RPC session did not report a sessionId after fork");
    if (!this.sessionFile) throw new Error("Pi RPC session did not report a sessionFile after fork");
  }

  private waitForAgentEnd(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for Pi RPC agent_end"));
      }, 24 * 60 * 60 * 1000);
      const onEvent = (event: unknown) => {
        if (!isRecord(event)) return;
        if (event.type === "agent_end") {
          cleanup();
          resolve();
        }
        if (event.type === "message_update" && isRecord(event.assistantMessageEvent) && event.assistantMessageEvent.type === "error") {
          cleanup();
          reject(new Error(String(event.assistantMessageEvent.reason ?? "Pi RPC stream error")));
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.emitter.off("event", onEvent);
      };
      this.emitter.on("event", onEvent);
    });
  }

  private async getSessionStats(): Promise<Record<string, unknown> | undefined> {
    try {
      const data = await this.rpc.request("get_session_stats");
      return isRecord(data) ? data : undefined;
    } catch {
      return undefined;
    }
  }

  private toState(state: Record<string, unknown>, sessionStats?: Record<string, unknown>): SessionState {
    const model = isRecord(state.model) ? state.model : undefined;
    const stats = sessionStats ?? (isRecord(state.stats) ? state.stats : undefined);
    const tokens = isRecord(stats?.tokens) ? stats.tokens : stats;
    const contextUsage = isRecord(stats?.contextUsage)
      ? stats.contextUsage
      : isRecord(state.contextUsage)
        ? state.contextUsage
        : undefined;
    const isStreaming = Boolean(state.isStreaming);
    const isCompacting = Boolean(state.isCompacting);
    return {
      id: String(state.sessionId ?? this.id),
      cwd: this.cwd,
      sessionFile: String(state.sessionFile ?? this.sessionFile),
      status: isCompacting ? "compacting" : isStreaming ? "running" : "idle",
      ...(typeof state.sessionName === "string" ? { sessionName: state.sessionName } : {}),
      ...(model ? { modelProvider: String(model.provider ?? ""), model: String(model.id ?? "") } : {}),
      messageCount: Number(state.messageCount ?? 0),
      totalTokens: Number(tokens?.total ?? sumNumbers(tokens, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "input", "output", "cacheRead", "cacheWrite"])),
      stats: {
        inputTokens: Number(tokens?.inputTokens ?? tokens?.input ?? 0),
        outputTokens: Number(tokens?.outputTokens ?? tokens?.output ?? 0),
        cacheReadTokens: Number(tokens?.cacheReadTokens ?? tokens?.cacheRead ?? 0),
        cacheWriteTokens: Number(tokens?.cacheWriteTokens ?? tokens?.cacheWrite ?? 0),
        cost: Number(stats?.cost ?? 0),
        contextTokens: numberOrNull(contextUsage?.tokens),
        contextPercent: numberOrNull(contextUsage?.percent),
        contextWindow: numberOrNull(contextUsage?.contextWindow ?? model?.contextWindow),
      },
      lastActivity: Date.now(),
    };
  }
}

interface SupervisedSpawnOptions {
  readonly piCommand: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly supervisorScript: string;
  readonly workerRegistry: WorkerRegistry;
}

interface SupervisedConnectOptions {
  readonly socketPath: string;
  readonly resumeFromSeq: number | null;
}

interface SupervisorHelloAck {
  readonly t: "hello";
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly lastSeq?: number;
  readonly ringLowSeq?: number | null;
}

/**
 * Client side of the supervisor wire protocol. Owns a single Unix-socket
 * connection at a time, but the supervisor process itself outlives any
 * particular adapter connection.
 */
class SupervisedRpcProcess {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventEmitter = new EventEmitter();
  private socket: net.Socket;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private disposeRequested = false;
  private lastSeq = 0;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.attachSocketHandlers();
  }

  static async spawnDetached(options: SupervisedSpawnOptions): Promise<SupervisedRpcProcess> {
    await options.workerRegistry.ensureDirs();
    const workerToken = crypto.randomUUID();
    const readyPath = options.workerRegistry.workerReadyPath(workerToken);
    // Defensively clear any stale ready file (shouldn't exist; token is fresh).
    try { await fs.unlink(readyPath); } catch { /* ignore */ }

    const child = spawn(process.execPath, [
      options.supervisorScript,
      "--command", options.piCommand,
      "--cwd", options.cwd,
      "--args", JSON.stringify(options.args),
      "--runtime-dir", options.workerRegistry.runtimeDir,
      "--worker-token", workerToken,
    ], {
      cwd: options.cwd,
      env: process.env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.on("error", () => { /* surfaced via ready timeout below */ });

    const ready = await waitForReadyFile(readyPath, 15_000);
    const socket = await connectSocket(ready.socketPath);
    const process_ = new SupervisedRpcProcess(socket);
    await process_.handshake(null);
    // Best-effort cleanup of the transient ready file.
    fs.unlink(readyPath).catch(() => {});
    return process_;
  }

  static async connect(options: SupervisedConnectOptions): Promise<SupervisedRpcProcess> {
    const socket = await connectSocket(options.socketPath);
    const process_ = new SupervisedRpcProcess(socket);
    await process_.handshake(options.resumeFromSeq);
    return process_;
  }

  onEvent(listener: (event: unknown, seq: number) => void): Unsubscribe {
    this.eventEmitter.on("event", listener);
    return () => this.eventEmitter.off("event", listener);
  }

  send(payload: Record<string, unknown>): void {
    if (this.closed) throw new Error("Pi RPC supervisor connection is closed");
    this.socket.write(JSON.stringify({ t: "rpc", data: payload }) + "\n");
  }

  async request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new Error("Pi RPC supervisor connection is closed");
    const id = `pirpc-${this.nextId++}`;
    const message = { id, type, ...payload };
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ t: "rpc", data: message }) + "\n", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
    if (!response.success) throw new Error(response.error ?? `${type} failed`);
    return response.data;
  }

  /** Tell the supervisor to shut its pi child down. Used for explicit deletes. */
  async dispose(): Promise<void> {
    if (this.disposeRequested) return;
    this.disposeRequested = true;
    if (!this.closed) {
      try { this.socket.write(JSON.stringify({ t: "shutdown" }) + "\n"); } catch {}
    }
    this.failAll(new Error("Pi RPC supervisor disposed"));
    await this.closeSocket();
  }

  /** Close the socket without shutting the supervisor down (API SIGTERM path). */
  async detach(): Promise<void> {
    this.failAll(new Error("Pi RPC supervisor detached"));
    await this.closeSocket();
  }

  private async handshake(resumeFromSeq: number | null): Promise<SupervisorHelloAck> {
    const helloWritten = new Promise<void>((resolve, reject) => {
      this.socket.write(JSON.stringify({ t: "hello", resumeFromSeq }) + "\n", (err) => err ? reject(err) : resolve());
    });
    await helloWritten;
    const ack = await this.waitForFrame((frame) => isRecord(frame) && frame.t === "hello");
    return ack as SupervisorHelloAck;
  }

  private waitForFrame(predicate: (frame: unknown) => boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.off("frame", onFrame);
        this.off("close", onClose);
        reject(new Error("Timed out waiting for supervisor frame"));
      }, 10_000);
      const onFrame = (frame: unknown) => {
        if (!predicate(frame)) return;
        clearTimeout(deadline);
        this.off("frame", onFrame);
        this.off("close", onClose);
        resolve(frame);
      };
      const onClose = () => {
        clearTimeout(deadline);
        this.off("frame", onFrame);
        this.off("close", onClose);
        reject(new Error("Supervisor connection closed before frame arrived"));
      };
      this.on("frame", onFrame);
      this.on("close", onClose);
    });
  }

  // Tiny internal event bus.
  private internal = new EventEmitter();
  private on(event: "frame" | "close", listener: (...args: any[]) => void) { this.internal.on(event, listener); }
  private off(event: "frame" | "close", listener: (...args: any[]) => void) { this.internal.off(event, listener); }
  private emitInternal(event: "frame" | "close", ...args: unknown[]) { this.internal.emit(event, ...args); }

  private attachSocketHandlers(): void {
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.receive(chunk));
    this.socket.on("error", (error) => this.failAll(error));
    this.socket.on("close", () => {
      this.closed = true;
      this.emitInternal("close");
      this.failAll(new Error("Pi RPC supervisor connection closed"));
    });
  }

  private async closeSocket(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      this.socket.once("close", done);
      try { this.socket.end(); } catch { /* ignore */ }
      // Don't wait for the supervisor's FIN — destroy promptly so detach is bounded.
      setTimeout(() => { try { this.socket.destroy(); } catch {} done(); }, 100).unref();
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      this.emitInternal("frame", parsed);
      this.dispatchFrame(parsed);
    }
  }

  private dispatchFrame(frame: unknown): void {
    if (!isRecord(frame)) return;
    if (frame.t === "hello") return; // handled by handshake
    if (frame.t === "resync") {
      // Inform consumers that they should refetch state. We surface as a
      // synthetic event so the registry-level ring can mark the resync point.
      this.eventEmitter.emit("event", {
        type: "session_resync",
        fromSeq: frame.fromSeq,
        ringLowSeq: frame.ringLowSeq,
        lastSeq: frame.lastSeq,
      }, typeof frame.lastSeq === "number" ? frame.lastSeq : this.lastSeq);
      return;
    }
    if (frame.t === "event") {
      const seq = typeof frame.seq === "number" ? frame.seq : this.lastSeq + 1;
      this.lastSeq = seq;
      const data = frame.data;
      if (isRecord(data) && data.type === "response" && typeof data.id === "string") {
        const pending = this.pending.get(data.id);
        if (pending) {
          this.pending.delete(data.id);
          pending.resolve(data as unknown as RpcResponse);
        }
        // Don't surface responses as events to consumers; matches old behavior.
        return;
      }
      this.eventEmitter.emit("event", data, seq);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function waitForReadyFile(file: string, timeoutMs: number): Promise<{ sessionId: string; socketPath: string; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.sessionId === "string" && typeof parsed.socketPath === "string") {
        return parsed;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(50);
  }
  throw lastError instanceof Error
    ? new Error(`Pi RPC supervisor did not become ready: ${lastError.message}`)
    : new Error("Pi RPC supervisor did not become ready");
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const onError = (err: Error) => { cleanup(); reject(err); };
    const onConnect = () => { cleanup(); resolve(socket); };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findSessionCwd(sessionFile: string, _sessionDir?: string): Promise<string | undefined> {
  // Used to call SessionManager.listAll() and find the matching entry, which
  // forced a full scan of every session jsonl just to read one file's cwd.
  // The cwd lives on the very first line (`type:"session"` header), so read
  // a small head window instead.
  try {
    const fd = await fs.open(sessionFile, "r");
    try {
      const buf = Buffer.alloc(8 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.byteLength, 0);
      if (bytesRead <= 0) return undefined;
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const firstNewline = text.indexOf("\n");
      const headerLine = firstNewline >= 0 ? text.slice(0, firstNewline) : text;
      const entry = JSON.parse(headerLine);
      if (entry && typeof entry === "object" && entry.type === "session" && typeof entry.cwd === "string") {
        return entry.cwd;
      }
      return undefined;
    } finally {
      await fd.close();
    }
  } catch {
    return undefined;
  }
}

function resolvePiCommand(): string {
  const local = path.resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  return existsSync(local) ? local : "pi";
}

function resolveSupervisorScript(): string {
  // src/server/pi/pirpc-pi-adapter.ts -> scripts/pirpc-supervisor.mjs (top-level)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../scripts/pirpc-supervisor.mjs"),
    path.resolve(process.cwd(), "scripts/pirpc-supervisor.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to project-root resolution; the supervisor will fail with a
  // clear error if this is wrong.
  return path.resolve(process.cwd(), "scripts/pirpc-supervisor.mjs");
}

async function resolveArtifactExtension(configured: false | string | undefined): Promise<string | undefined> {
  if (configured === false) return undefined;
  if (typeof configured === "string") return path.resolve(configured);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "extensions", "pi-crust-artifacts.ts"),
    path.join(here, "extensions", "pi-crust-artifacts.js"),
    path.resolve(process.cwd(), "src", "server", "pi", "extensions", "pi-crust-artifacts.ts"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next path
    }
  }
  return undefined;
}

/**
 * Locate `@cemoody/pi-artifact`'s entry point so we can pass it as a second
 * `--extension` arg when spawning a pi worker. This is the package whose
 * `display(...)` tool emits `customType: "artifact"` messages with the
 * multi-MIME wire format that `ArtifactView` in `MessageTimeline.tsx`
 * renders. We resolve it lazily — if the user has uninstalled it, or set
 * `PI_CRUST_DISABLE_CEMOODY_ARTIFACT=1`, we just skip it.
 */
export interface CemoodyArtifactResolveOptions {
  /** Roots from which to walk up looking for `node_modules/@cemoody/pi-artifact`.
   *  Defaults to `[<this file's dir>, process.cwd()]`. Override in tests to
   *  scope the lookup to a temp directory tree. */
  readonly searchRoots?: readonly string[];
  /** Env source. Defaults to `process.env`; override in tests. */
  readonly env?: Record<string, string | undefined>;
  /** Pi settings path. Defaults to `$HOME/.pi/agent/settings.json`; override in tests. */
  readonly piSettingsPath?: string;
}

export async function resolveCemoodyArtifactExtension(options: CemoodyArtifactResolveOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env.PI_CRUST_DISABLE_CEMOODY_ARTIFACT === "1") return undefined;

  // If the user's normal Pi configuration already installs pi-artifact (for
  // example `../../pi-artifact` during local development), don't pass the
  // bundled @cemoody/pi-artifact as an extra `--extension`. Pi will load the
  // configured package itself, and double-loading registers `display` twice.
  if (await piSettingsAlreadyIncludesArtifact(options.piSettingsPath, env)) return undefined;

  // Honor an explicit override path (useful for local development against a
  // sibling checkout of cemoody/pi-artifact).
  const override = env.PI_CRUST_CEMOODY_ARTIFACT_PATH;
  if (override) {
    try {
      const resolved = path.resolve(override);
      await fs.access(resolved);
      return resolved;
    } catch {
      // fall through to package resolution
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Walk up to find a node_modules/@cemoody/pi-artifact. We avoid
  // `require.resolve` here because this file is ESM-only and we want to
  // resolve a TypeScript source path (pi loads `.ts` extensions directly).
  const roots = options.searchRoots ?? [here, process.cwd()];
  for (const root of roots) {
    let dir = root;
    // Bounded walk so we don't traverse the whole filesystem.
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, "node_modules", "@cemoody", "pi-artifact");
      try {
        await fs.access(candidate);
        const manifest = JSON.parse(await fs.readFile(path.join(candidate, "package.json"), "utf8"));
        const piEntry: string | undefined = Array.isArray(manifest?.pi?.extensions) && typeof manifest.pi.extensions[0] === "string"
          ? manifest.pi.extensions[0]
          : undefined;
        const entryRelative = piEntry ?? "./src/index.ts";
        const entryAbsolute = path.resolve(candidate, entryRelative);
        await fs.access(entryAbsolute);
        return entryAbsolute;
      } catch {
        // try the next directory up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

async function piSettingsAlreadyIncludesArtifact(
  configuredPath: string | undefined,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const settingsPath = configuredPath
    ?? (env.HOME ? path.join(env.HOME, ".pi", "agent", "settings.json") : undefined);
  if (!settingsPath) return false;
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const packages = Array.isArray(parsed?.packages) ? parsed.packages : [];
    return packages.some((source: unknown) => typeof source === "string" && /(^|[/@:])pi-artifact($|[/#?])/i.test(source));
  } catch {
    return false;
  }
}

export function toSessionMessages(messages: readonly unknown[]): SessionMessage[] {
  const result: SessionMessage[] = [];
  const toolCallIndexes = new Map<string, number>();

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = String(message.role ?? "");
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();

    if (role === "compactionSummary") {
      const summary = typeof message.summary === "string" ? message.summary : contentText(message.content);
      if (summary.trim()) {
        result.push({
          role: "summary",
          content: summary,
          timestamp,
          summaryKind: "compaction",
        });
      }
      continue;
    }

    if (role === "branchSummary") {
      const summary = typeof message.summary === "string" ? message.summary : contentText(message.content);
      if (summary.trim()) {
        result.push({
          role: "summary",
          content: summary,
          timestamp,
          summaryKind: "branch",
        });
      }
      continue;
    }

    if (role === "custom" || (typeof message.customType === "string" && message.customType.length > 0)) {
      const customType = String(message.customType ?? "");
      const content = typeof message.content === "string" ? message.content : contentText(message.content);
      const details = isRecord(message.details) ? (message.details as Record<string, unknown>) : undefined;
      result.push({
        role: "custom",
        content,
        timestamp,
        ...(customType ? { customType } : {}),
        ...(details ? { details } : {}),
      });
      continue;
    }

    if (role === "assistant") {
      const { text: rawText, thinking } = contentTextAndThinking(message.content);
      const text = rawText.trim();
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
      // Emit an assistant entry whenever we have visible text OR thinking
      // OR when the turn ended in an error / non-trivial stopReason.
      // Without this the pi-crust sees nothing for failed turns and looks
      // "frozen".
      const trimmedThinking = thinking.trim();
      const shouldEmit = text.length > 0 || trimmedThinking.length > 0 || stopReason === "error" || errorMessage !== undefined;
      if (shouldEmit) {
        result.push({
          role: "assistant",
          content: text,
          timestamp,
          ...(trimmedThinking ? { thinking: trimmedThinking } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        });
      }

      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const id = String(block.id ?? block.toolCallId ?? "");
        if (!id) continue;
        const args = isRecord(block.arguments)
          ? block.arguments
          : isRecord(block.input)
            ? block.input
            : {};
        const index = result.length;
        result.push({
          role: "tool",
          content: "",
          timestamp,
          tool: {
            id,
            name: String(block.name ?? block.toolName ?? ""),
            args,
            status: "running",
            output: "",
            // The assistant turn's timestamp is when the toolCall was
            // emitted — the best proxy for 'tool started' we have at the
            // JSONL reload path. Streaming overlays a more precise
            // Date.now() via the SSE event reducer.
            startedAt: timestamp,
          },
        });
        toolCallIndexes.set(id, index);
      }
      continue;
    }

    if (role === "user" || role === "system") {
      const { text, images } = contentTextAndImages(message.content);
      result.push({
        role: role as "user" | "system",
        content: text,
        timestamp,
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }

    if (role === "toolResult") {
      const output = contentText(message.content);
      const toolCallId = String(message.toolCallId ?? message.id ?? "");
      const artifact = extractToolResultArtifact(message.details);
      const index = toolCallIndexes.get(toolCallId);
      if (index !== undefined) {
        const previous = result[index];
        if (previous?.role === "tool" && previous.tool) {
          result[index] = {
            ...previous,
            content: output,
            timestamp,
            tool: {
              ...previous.tool,
              status: message.isError ? "error" : "success",
              output,
              completedAt: timestamp,
              ...(artifact === undefined ? {} : { artifact }),
            },
          };
          continue;
        }
      }
      result.push({ role: "tool", content: output, timestamp });
    }
  }

  return result;
}

function contentText(content: unknown): string {
  return contentTextAndImages(content).text;
}

/**
 * Pull `details.piRemoteControlArtifact` (if present) out of a toolResult
 * message's persisted details. Used so that artifacts attached to tool
 * results (show_presentation, show_artifact, etc.) survive a /messages
 * fetch and re-render correctly after a page reload.
 */
function extractToolResultArtifact(details: unknown): unknown {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { piRemoteControlArtifact?: unknown }).piRemoteControlArtifact;
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? value : undefined;
}

function contentTextAndImages(content: unknown): { text: string; images: NonNullable<SessionMessage["images"]> } {
  // Reuse the unified extractor and drop thinking on the floor for callers
  // (user / system / toolResult) that don't surface a separate thinking
  // field. Assistant messages go through contentTextAndThinking instead.
  const { text, images } = contentTextAndThinking(content);
  return { text, images };
}

/**
 * Decompose a SessionMessage `content` payload into its visible-text,
 * thinking, and image components. Mirrors the on-disk pirpc / Anthropic-
 * messages content-block shape:
 *
 *   string                                 -> { text, thinking:'', images:[] }
 *   [{type:'text',text}, {type:'thinking',thinking}, {type:'image',data}]
 *                                          -> per-field decomposition
 *   anything else                          -> JSON.stringify fallback
 *
 * Exported because the /messages HTTP route (toDashboardMessages in
 * http-api-server.ts) needs the same fan-out as the adapter's own
 * getMessages() path: PR #102's tail-read fast path bypasses the adapter
 * entirely, so without this helper a fresh session-load sends array
 * content straight to the pi-crust and the safe-markdown coercion in
 * MessageTimeline stringifies the blocks into the assistant bubble. Pinned
 * by tests/playwright/structured-content-tool-calls.spec.ts.
 */
export function contentTextAndThinking(content: unknown): { text: string; thinking: string; images: NonNullable<SessionMessage["images"]> } {
  if (typeof content === "string") return { text: content, thinking: "", images: [] };
  if (!Array.isArray(content)) return { text: content === undefined ? "" : JSON.stringify(content), thinking: "", images: [] };
  const text: string[] = [];
  const thinking: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    // Order matters for stop-reason-error edge cases: a thinking block
    // with no following text still produces an entry, but the user-visible
    // bubble stays empty (thinking renders in its own collapsed widget).
    if (typeof block.thinking === "string") thinking.push(block.thinking);
    if (typeof block.text === "string") text.push(block.text);
    if (block.type === "image" && typeof block.data === "string") {
      images.push({ data: block.data, mimeType: String(block.mimeType ?? "image/png") });
    }
  }
  return { text: text.join("\n"), thinking: thinking.join("\n\n"), images };
}

async function ensureSessionManagerFileExists(sessionManager: SessionManager, sessionFile: string): Promise<void> {
  try {
    await fs.access(sessionFile);
    return;
  } catch { /* create below */ }
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const header = sessionManager.getHeader();
  if (!header) throw new Error("Forked session is missing a header");
  const entries = [header, ...sessionManager.getEntries()];
  await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function parseForkResult(data: unknown): ForkSessionResult {
  if (!isRecord(data)) return { cancelled: false };
  return {
    cancelled: data.cancelled === true,
    ...(typeof data.text === "string" ? { text: data.text } : {}),
  };
}

function parseCloneResult(data: unknown): CloneSessionResult {
  return { cancelled: isRecord(data) && data.cancelled === true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateLikeToTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

function sumNumbers(record: Record<string, unknown> | undefined, keys: readonly string[]): number {
  if (!record) return 0;
  return keys.reduce((sum, key) => sum + Number(record[key] ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Fast session lister: head+tail scan, no full-file parse.
// ---------------------------------------------------------------------------

/** Bytes we read from the start of each session jsonl. Holds the
 * `type:"session"` header plus the first few messages (firstMessage) and
 * an initial `session_info` rename. */
const FAST_LIST_HEAD_BYTES = 16 * 1024;
/** Bytes we read from the end of each session jsonl. Holds the most recent
 * `session_info` and a timestamp for lastActivity. */
const FAST_LIST_TAIL_BYTES = 32 * 1024;
/** Cap on parallel file-handle open()s while scanning the sessions dir. */
const FAST_LIST_CONCURRENCY = 32;

interface ScannedSession {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly sessionName?: string;
  readonly firstMessage?: string;
  readonly createdAt: number | null;
  readonly lastActivity: number;
}

export async function fastListSessions(sessionDir: string | undefined, _cwdFilter?: string): Promise<readonly SessionListItem[]> {
  if (!sessionDir) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionDir, entry.name));

  // NOTE: We intentionally ignore _cwdFilter here. The historical contract of
  // SessionManager.list(cwd, sessionDir) in the pi SDK is: when sessionDir is
  // provided (which pirpc-pi-adapter always does), the cwd argument is only
  // used to derive a *default* sessionDir, NOT to filter the returned
  // sessions. listSessionsFromDir() reads every .jsonl in the dir regardless
  // of header.cwd. A previous version of this function filtered by exact
  // cwd match and made sessions created in child worktrees disappear from
  // the sidebar (#106 revert). The pathPolicy security gate in
  // SessionRegistry.listSessions() still drops sessions whose cwd isn't
  // under an allowed root, which is the only filter the caller actually
  // wants.
  const results: (ScannedSession | null)[] = new Array(candidates.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= candidates.length) return;
      results[index] = await scanSessionFile(candidates[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAST_LIST_CONCURRENCY, candidates.length) }, worker));

  const sessions: SessionListItem[] = [];
  for (const item of results) {
    if (!item) continue;
    sessions.push({
      id: item.id,
      cwd: item.cwd,
      sessionFile: item.sessionFile,
      ...(item.sessionName === undefined ? {} : { sessionName: item.sessionName }),
      ...(item.firstMessage === undefined ? {} : { firstMessage: item.firstMessage }),
      createdAt: item.createdAt,
      lastActivity: item.lastActivity,
    });
  }
  // Match SessionManager.list()'s ordering: most-recently-modified first.
  sessions.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return sessions;
}

async function scanSessionFile(filePath: string): Promise<ScannedSession | null> {
  let stat: import("node:fs").Stats;
  try { stat = await fs.stat(filePath); } catch { return null; }
  if (!stat.isFile() || stat.size === 0) return null;

  const headSize = Math.min(FAST_LIST_HEAD_BYTES, stat.size);
  const tailStart = Math.max(headSize, stat.size - FAST_LIST_TAIL_BYTES);
  const tailSize = stat.size - tailStart;

  let fd: import("node:fs/promises").FileHandle;
  try { fd = await fs.open(filePath, "r"); } catch { return null; }
  try {
    const headBuf = Buffer.alloc(headSize);
    await fd.read(headBuf, 0, headSize, 0);
    let tailText = "";
    if (tailSize > 0 && tailStart > 0) {
      const tailBuf = Buffer.alloc(tailSize);
      await fd.read(tailBuf, 0, tailSize, tailStart);
      tailText = tailBuf.toString("utf8");
      // Drop the (likely partial) first line in the tail window so we don't
      // parse a fragment.
      const firstNewline = tailText.indexOf("\n");
      if (firstNewline >= 0) tailText = tailText.slice(firstNewline + 1);
    }
    const headText = headBuf.toString("utf8");
    // If head and tail overlap (small file) we'll iterate twice; the merge
    // logic below tolerates duplicates.
    return parseScannedSession(filePath, stat, headText, tailText);
  } finally {
    await fd.close();
  }
}

function parseScannedSession(
  filePath: string,
  stat: import("node:fs").Stats,
  headText: string,
  tailText: string,
): ScannedSession | null {
  let id: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | null = null;
  let firstMessage: string | undefined;
  let sessionName: string | undefined;
  let sessionNameSeenAt = -1; // entry index of latest session_info
  let lastActivity = 0;
  let entryIndex = 0;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let entry: unknown;
    try { entry = JSON.parse(trimmed); } catch { return; }
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const i = entryIndex++;
    if (record.type === "session") {
      if (id === undefined && typeof record.id === "string") id = record.id;
      if (cwd === undefined && typeof record.cwd === "string") cwd = record.cwd;
      if (createdAt === null) createdAt = dateLikeToTime(record.timestamp) ?? null;
      const ts = dateLikeToTime(record.timestamp);
      if (ts !== undefined && ts > lastActivity) lastActivity = ts;
      return;
    }
    if (record.type === "session_info") {
      if (i > sessionNameSeenAt) {
        sessionNameSeenAt = i;
        const candidate = typeof record.name === "string" ? record.name.trim() : "";
        sessionName = candidate || undefined;
      }
    }
    if (record.type === "message") {
      const inner = isRecord(record.message) ? record.message : undefined;
      const ts = dateLikeToTime(inner?.timestamp) ?? dateLikeToTime(record.timestamp);
      if (ts !== undefined && ts > lastActivity) lastActivity = ts;
      if (firstMessage === undefined && inner && inner.role === "user") {
        firstMessage = extractFirstMessageText(inner.content);
      }
    }
  };

  for (const line of headText.split("\n")) handleLine(line);
  for (const line of tailText.split("\n")) handleLine(line);

  if (!id) return null;
  const resolvedCwd = cwd ?? "";
  if (lastActivity === 0) lastActivity = stat.mtimeMs;
  return {
    id,
    cwd: resolvedCwd,
    sessionFile: filePath,
    ...(sessionName === undefined ? {} : { sessionName }),
    ...(firstMessage === undefined ? {} : { firstMessage }),
    createdAt: createdAt ?? null,
    lastActivity,
  };
}

function extractFirstMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.slice(0, 240);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) return text.slice(0, 240);
      }
    }
  }
  return undefined;
}
