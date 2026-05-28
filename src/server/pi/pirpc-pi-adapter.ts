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
import { coerceTimestamp, isRecord, numberOrNull, optional, sumNumbers } from "../../shared/util.js";
import { contentTextAndThinking as sharedContentTextAndThinking } from "../../shared/wire-content.js";
import { fastListSessions } from "./session-jsonl-scanner.js";
// Re-export so any external import path keeps working without churn.
export { fastListSessions } from "./session-jsonl-scanner.js";

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
      ...optional({ sessionDir: this.options.sessionDir }),
      ...optional({ extraArgs: this.options.extraArgs }),
      ...optional({ artifactExtension: this.options.artifactExtension }),
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
      ...optional({ sessionDir: this.options.sessionDir }),
      ...optional({ extraArgs: this.options.extraArgs }),
      ...optional({ artifactExtension: this.options.artifactExtension }),
    });
  }

  async reattachSession(options: ReattachSessionOptions): Promise<PiSessionHandle> {
    return PiRpcSessionHandle.reattach({
      sessionId: options.sessionId,
      socketPath: options.socketPath,
      sessionFile: options.sessionFile,
      cwd: options.cwd,
      piCommand: this.piCommand,
      supervisorScript: this.supervisorScript,
      workerRegistry: this.workerRegistry,
      ...optional({ sessionDir: this.options.sessionDir }),
      ...optional({ extraArgs: this.options.extraArgs }),
      ...optional({ artifactExtension: this.options.artifactExtension }),
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
      ...optional({ sessionDir: this.options.sessionDir }),
      ...optional({ extraArgs: this.options.extraArgs }),
      ...optional({ artifactExtension: this.options.artifactExtension }),
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
  readonly piCommand: string;
  readonly supervisorScript: string;
  readonly workerRegistry: WorkerRegistry;
  readonly sessionDir?: string;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
}

interface RestartOptions {
  readonly piCommand: string;
  readonly supervisorScript: string;
  readonly workerRegistry: WorkerRegistry;
  readonly sessionDir?: string;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
}

function restartOptionsFromSpawn(options: SpawnSessionOptions): RestartOptions {
  return {
    piCommand: options.piCommand,
    supervisorScript: options.supervisorScript,
    workerRegistry: options.workerRegistry,
    ...optional({ sessionDir: options.sessionDir }),
    ...optional({ extraArgs: options.extraArgs }),
    ...optional({ artifactExtension: options.artifactExtension }),
  };
}

function restartOptionsFromReattach(options: ReattachInternalOptions): RestartOptions {
  return {
    piCommand: options.piCommand,
    supervisorScript: options.supervisorScript,
    workerRegistry: options.workerRegistry,
    ...optional({ sessionDir: options.sessionDir }),
    ...optional({ extraArgs: options.extraArgs }),
    ...optional({ artifactExtension: options.artifactExtension }),
  };
}

class PiRpcSessionHandle implements PiSessionHandle {
  id: string;
  cwd: string;
  sessionFile: string;

  private rpc: SupervisedRpcProcess;
  private readonly emitter = new EventEmitter();
  private readonly seqEmitter = new EventEmitter();
  private latestState: Record<string, unknown>;
  private disposed = false;
  private detached = false;

  private constructor(rpc: SupervisedRpcProcess, cwd: string, state: Record<string, unknown>, private readonly restartOptions: RestartOptions) {
    this.rpc = rpc;
    this.cwd = cwd;
    this.latestState = state;
    this.id = String(state.sessionId ?? "");
    this.sessionFile = String(state.sessionFile ?? "");
    if (!this.id) throw new Error("Pi RPC session did not report a sessionId");
    if (!this.sessionFile) throw new Error("Pi RPC session did not report a sessionFile");
    this.attachRpc(rpc, state);
  }

  /**
   * Returns false if the handle's underlying supervisor connection is closed
   * (i.e. the next request would throw "supervisor connection is closed").
   * Used by /api/health to surface broken sessions before users hit them.
   */
  isHealthy(): boolean {
    return !this.rpc.isClosed();
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
      return new PiRpcSessionHandle(rpc, options.cwd, state, restartOptionsFromSpawn(options));
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
    return new PiRpcSessionHandle(rpc, options.cwd, state, restartOptionsFromReattach(options));
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

  async compact(customInstructions?: string): Promise<unknown> {
    return this.rpc.request("compact", customInstructions?.trim() ? { customInstructions } : {});
  }

  async reload(): Promise<SessionState> {
    const previousRpc = this.rpc;
    const previousSupervisorPid = previousRpc.observabilityContext.supervisorPid;
    await previousRpc.dispose();
    if (typeof previousSupervisorPid === "number") {
      await waitForProcessExit(previousSupervisorPid, 3_000);
    }

    const rpc = await SupervisedRpcProcess.spawnDetached({
      piCommand: this.restartOptions.piCommand,
      args: await buildPiRpcArgs({
        sessionFile: this.sessionFile,
        ...optional({ sessionDir: this.restartOptions.sessionDir }),
        ...optional({ extraArgs: this.restartOptions.extraArgs }),
        ...optional({ artifactExtension: this.restartOptions.artifactExtension }),
      }),
      cwd: this.cwd,
      supervisorScript: this.restartOptions.supervisorScript,
      workerRegistry: this.restartOptions.workerRegistry,
    });
    try {
      const state = await rpc.request("get_state");
      if (!isRecord(state)) throw new Error("Pi RPC get_state returned invalid data after reload");
      this.rpc = rpc;
      this.latestState = state;
      this.cwd = String(state.cwd ?? this.cwd);
      this.id = String(state.sessionId ?? this.id);
      this.sessionFile = String(state.sessionFile ?? this.sessionFile);
      this.attachRpc(rpc, state);
      return this.toState(state);
    } catch (error) {
      await rpc.dispose();
      throw error;
    }
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

  private attachRpc(rpc: SupervisedRpcProcess, state: Record<string, unknown>): void {
    rpc.observabilityContext = { sessionId: this.id };
    if (typeof state.pid === "number") rpc.observabilityContext.supervisorPid = state.pid;
    rpc.onEvent((event, seq) => {
      if (this.rpc !== rpc) return;
      this.emitter.emit("event", event as PiEvent);
      this.seqEmitter.emit("event", event as PiEvent, seq);
    });
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
  private detached = false;
  private lastSeq = 0;

  // Reconnect state. socketPath is captured at construction so a transient
  // socket close (e.g. supervisor's currentClient eviction, kernel-side
  // half-close, etc.) can be transparently recovered by request() before it
  // gives up. reopening is a singleton promise to deduplicate concurrent
  // reopen attempts that hit at the same time.
  private socketPath: string | null = null;
  private reopening: Promise<boolean> | null = null;
  private reopenAttempts = 0;
  private static readonly RECONNECT_MAX_ATTEMPTS_PER_REQUEST = 1;

  // Observability: track close lifecycle + last request so the structured
  // unexpected-close log is actionable. See logUnexpectedClose() below.
  readonly openedAt: number = Date.now();
  closedAt: number | null = null;
  lastRequestType: string | null = null;
  // Populated by PiRpcSessionHandle.reattach()/spawn() before any request,
  // so the close-log can name the session that just broke.
  observabilityContext: { sessionId?: string; supervisorPid?: number; socketPath?: string } = {};

  isClosed(): boolean { return this.closed; }

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
    process_.socketPath = ready.socketPath;
    process_.observabilityContext.socketPath = ready.socketPath;
    await process_.handshake(null);
    // Best-effort cleanup of the transient ready file.
    fs.unlink(readyPath).catch(() => {});
    return process_;
  }

  static async connect(options: SupervisedConnectOptions): Promise<SupervisedRpcProcess> {
    const socket = await connectSocket(options.socketPath);
    const process_ = new SupervisedRpcProcess(socket);
    process_.socketPath = options.socketPath;
    process_.observabilityContext.socketPath = options.socketPath;
    await process_.handshake(options.resumeFromSeq);
    return process_;
  }

  onEvent(listener: (event: unknown, seq: number) => void): Unsubscribe {
    this.eventEmitter.on("event", listener);
    return () => this.eventEmitter.off("event", listener);
  }

  send(payload: Record<string, unknown>): void {
    if (this.closed) {
      // We deliberately do NOT auto-reopen for fire-and-forget send() because
      // there's no response correlation to wait on — the caller wouldn't know
      // if their payload made it. request() is the user-facing path that
      // matters; send() is rare (only used by respondToExtensionUi today).
      logRejectedHandleClosed(this, typeof payload?.type === "string" ? payload.type : "<send>");
      throw new Error("Pi RPC supervisor connection is closed");
    }
    this.socket.write(JSON.stringify({ t: "rpc", data: payload }) + "\n");
  }

  async request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) {
      // Auto-reconnect once per request before giving up. This is the FIX for
      // the 2026-05-24 silent-disconnect outage: the supervisor's UDS socket
      // can be evicted out from under us (e.g. currentClient eviction by an
      // openSession spawn-probe) without the supervisor process dying. In
      // that case the supervisor is still happily listening on its socket,
      // we just need to re-open ours. PR-A/B/C added the telemetry; this is
      // the actual fix.
      const reopened = await this.tryReopen(type);
      if (!reopened) {
        logRejectedHandleClosed(this, type);
        throw new Error("Pi RPC supervisor connection is closed");
      }
      // Successfully reopened. Fall through and issue the request below.
    }
    this.lastRequestType = type;
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
    // A successful round-trip proves the connection is healthy enough to
    // allow another reconnect attempt next time something breaks. Without
    // this, a single retry would burn the budget forever after the first
    // successful reopen.
    this.reopenAttempts = 0;
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
    this.detached = true;
    this.failAll(new Error("Pi RPC supervisor detached"));
    await this.closeSocket();
  }

  /** True when close() was driven by API-initiated dispose() or detach() */
  isIntentionalClose(): boolean { return this.disposeRequested || this.detached; }

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
    // IMPORTANT: capture the socket reference at handler registration time.
    // After a reopen, this.socket will point at a NEW socket, but the OLD
    // socket will still fire its 'close' event as it tears down. The captured
    // ref lets us no-op for those stale close events instead of marking the
    // freshly-reopened connection as closed.
    const sock = this.socket;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => { if (sock === this.socket) this.receive(chunk); });
    sock.on("error", (error) => { if (sock === this.socket) this.failAll(error); });
    sock.on("close", () => {
      // Stale: another socket has taken over (via reopen). Ignore.
      if (sock !== this.socket) return;
      const wasAlreadyClosed = this.closed;
      this.closed = true;
      if (this.closedAt === null) this.closedAt = Date.now();
      // Only emit the unexpected-close log line for the FIRST close (so a
      // detach/dispose followed by socket close doesn't double-log) and only
      // when neither dispose() nor detach() initiated it.
      if (!wasAlreadyClosed && !this.isIntentionalClose()) {
        logUnexpectedClose(this);
      }
      this.emitInternal("close");
      this.failAll(new Error("Pi RPC supervisor connection closed"));
    });
  }

  /**
   * Try to recover a closed handle by opening a fresh socket to the same
   * supervisor and re-running the hello/ack handshake with resumeFromSeq
   * set to our lastSeq (so the supervisor replays any events we missed
   * while disconnected). Returns true on success, false on failure.
   *
   * Idempotent / deduped: concurrent callers awaiting the same reopen
   * share the underlying promise. Intentional closes (dispose / detach)
   * are NEVER reopened.
   */
  private async tryReopen(requestType: string): Promise<boolean> {
    if (this.disposeRequested || this.detached) return false;
    if (!this.socketPath) return false; // can't reconnect without knowing where
    if (!this.closed) return true; // already healthy
    if (this.reopenAttempts >= SupervisedRpcProcess.RECONNECT_MAX_ATTEMPTS_PER_REQUEST) {
      // Per-handle cap so we don't spin in a tight loop against a permanently
      // broken supervisor. Reset on each successful request (see below).
      return false;
    }
    if (this.reopening) return this.reopening;

    this.reopenAttempts += 1;
    const ctx = this.observabilityContext;
    const resumeFromSeq = this.lastSeq;
    logReopenAttempt(this, requestType);

    this.reopening = (async () => {
      try {
        const newSocket = await connectSocket(this.socketPath!);
        // Replace the socket FIRST so the old socket's close handler no-ops.
        const oldSocket = this.socket;
        this.socket = newSocket;
        // Clear closed flags so the new socket's handshake & subsequent
        // request can write through. Note: failAll() ran when the old socket
        // closed, so this.pending is already empty.
        this.closed = false;
        this.closedAt = null;
        this.buffer = "";
        this.attachSocketHandlers();
        // Tear down the old socket now that it can't affect us.
        try { oldSocket.destroy(); } catch { /* ignore */ }

        // Re-run the hello handshake. The supervisor's currentClient is
        // replaced by this new connection; resumeFromSeq tells it to backfill
        // missed ring events to our event listeners.
        await this.handshake(resumeFromSeq);
        logReopenSucceeded(this, requestType, resumeFromSeq);
        return true;
      } catch (err) {
        this.closed = true;
        if (this.closedAt === null) this.closedAt = Date.now();
        logReopenFailed(this, requestType, err);
        return false;
      } finally {
        this.reopening = null;
      }
    })();
    return this.reopening;
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

async function buildPiRpcArgs(options: {
  readonly sessionFile?: string;
  readonly sessionDir?: string;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
}): Promise<string[]> {
  const args = ["--mode", "rpc"];
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  if (options.sessionFile) args.push("--session", options.sessionFile);
  const extension = await resolveArtifactExtension(options.artifactExtension);
  if (extension) args.push("--extension", extension);
  const cemoodyExtension = await resolveCemoodyArtifactExtension();
  if (cemoodyExtension) args.push("--extension", cemoodyExtension);
  args.push(...(options.extraArgs ?? []));
  return args;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(50);
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
              ...optional({ artifact }),
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
  return sharedContentTextAndThinking(content).text;
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
  // Reuse the canonical extractor and drop thinking on the floor for callers
  // (user / system / toolResult) that don't surface a separate thinking
  // field. Assistant messages go through contentTextAndThinking instead.
  const { text, images } = sharedContentTextAndThinking(content);
  return { text, images: images as NonNullable<SessionMessage["images"]> };
}

/**
 * Pirpc-flavoured decomposer that also returns extracted image attachments.
 * Delegates to the canonical helper in shared/wire-content.ts and just
 * widens its readonly `images` type back to the SessionMessage mutable
 * shape the HTTP layer expects.
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
  const { text, thinking, images } = sharedContentTextAndThinking(content);
  return { text, thinking, images: images as NonNullable<SessionMessage["images"]> };
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

// ---------------------------------------------------------------------------
// Observability helpers (added 2026-05-24). These are structured-log shims
// that surface the silent "supervisor handle closed but nobody noticed"
// failure mode we hit in production. Both emit a single JSON line to stderr
// per event so an operator can `grep pirpc.handle.unexpected_close` (or
// pipe to a log aggregator) and see exactly which sessions broke and when.
//
// Why structured? Lets you `grep -E '"event":"pirpc.handle.unexpected_close"'`
// or jq your way through the API stderr without false positives from the
// surrounding human-readable log noise.
// ---------------------------------------------------------------------------

function logUnexpectedClose(rpc: SupervisedRpcProcess): void {
  const ctx = rpc.observabilityContext;
  const ageMs = (rpc.closedAt ?? Date.now()) - rpc.openedAt;
  const payload = {
    level: "warn",
    event: "pirpc.handle.unexpected_close",
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    supervisorPid: ctx.supervisorPid,
    socketPath: ctx.socketPath,
    ageMs,
    lastRequestType: rpc.lastRequestType,
  };
  // Use console.warn so it lands on stderr separately from regular console.log
  // output; one line per event keeps it grep-friendly.
  console.warn(JSON.stringify(payload));
}

function logReopenAttempt(rpc: SupervisedRpcProcess, requestType: string): void {
  const ctx = rpc.observabilityContext;
  console.warn(JSON.stringify({
    level: "warn",
    event: "pirpc.handle.reopen_attempt",
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    supervisorPid: ctx.supervisorPid,
    socketPath: ctx.socketPath,
    requestType,
  }));
}

function logReopenSucceeded(rpc: SupervisedRpcProcess, requestType: string, resumeFromSeq: number): void {
  const ctx = rpc.observabilityContext;
  console.warn(JSON.stringify({
    level: "info",
    event: "pirpc.handle.reopen_succeeded",
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    supervisorPid: ctx.supervisorPid,
    requestType,
    resumeFromSeq,
  }));
}

function logReopenFailed(rpc: SupervisedRpcProcess, requestType: string, err: unknown): void {
  const ctx = rpc.observabilityContext;
  console.error(JSON.stringify({
    level: "error",
    event: "pirpc.handle.reopen_failed",
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    supervisorPid: ctx.supervisorPid,
    socketPath: ctx.socketPath,
    requestType,
    error: err instanceof Error ? err.message : String(err),
  }));
}

function logRejectedHandleClosed(rpc: SupervisedRpcProcess, requestType: string): void {
  const ctx = rpc.observabilityContext;
  const closedAt = rpc.closedAt ?? Date.now();
  const payload = {
    level: "error",
    event: "pirpc.request.rejected_handle_closed",
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    supervisorPid: ctx.supervisorPid,
    requestType,
    closedAgeMs: Date.now() - closedAt,
  };
  console.error(JSON.stringify(payload));
}
