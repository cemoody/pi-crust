import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
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
import { sanitizePiDynamicCommands, type PiDynamicCommandInfo } from "../../shared/slash-command-routing.js";
import { fastListSessions } from "./session-jsonl-scanner.js";
import { resolvePiCommand } from "../pi-version.js";
import { loadNormalizedTranscriptMessages } from "./transcripts/index.js";
import { SupervisedRpcProcess } from "./supervision/supervised-rpc-process.js";
// Compatibility export for external consumers that historically imported the
// normalizer from this adapter module. New production callers use
// pi/transcripts instead.
export { contentTextAndThinking, toSessionMessages } from "./transcripts/index.js";
// Re-export so any external import path keeps working without churn.
export { fastListSessions } from "./session-jsonl-scanner.js";

export interface PiRpcAdapterOptions {
  readonly sessionDir?: string;
  readonly piCommand?: string;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
  readonly runtimeDir?: string;
  readonly supervisorScript?: string;
  /**
   * Resolves the workspace-wide system prompt at spawn time. Returning a
   * non-empty string causes a `--append-system-prompt <text>` arg to be added
   * to each freshly spawned pi worker. Read lazily so edits in Settings take
   * effect on the next session without an API restart.
   */
  readonly getAppendSystemPrompt?: () => Promise<string | undefined> | string | undefined;
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

  /** Build the per-spawn extra args, appending the global system prompt (if any). */
  private async resolveExtraArgs(): Promise<readonly string[]> {
    const base = this.options.extraArgs ?? [];
    const prompt = (await this.options.getAppendSystemPrompt?.())?.trim();
    if (!prompt) return base;
    return [...base, "--append-system-prompt", prompt];
  }

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
      ...optional({ extraArgs: await this.resolveExtraArgs() }),
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
      ...optional({ extraArgs: await this.resolveExtraArgs() }),
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
      ...optional({ extraArgs: await this.resolveExtraArgs() }),
      ...optional({ artifactExtension: this.options.artifactExtension }),
    });
    return { result: { cancelled: false, text: selectedText }, handle };
  }

  async listSessions(cwd?: string, options: { readonly includeHidden?: boolean; readonly includeSubagents?: boolean } = {}): Promise<readonly SessionListItem[]> {
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
    return fastListSessions(this.options.sessionDir, cwd, options);
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    // Provider extensions (for example pi-provider-litellm) register models
    // inside the running Pi process, not in this API process's standalone
    // ModelRegistry. Prefer live session registries in SessionRegistry.listModels()
    // when available; this fallback is for empty/cold dashboards.
    return toModelInfo(await this.modelRegistry.getAvailable());
  }
}

function toModelInfo(models: readonly unknown[]): ModelInfo[] {
  return models
    .filter(isRecord)
    .map((model) => ({
      provider: String(model.provider ?? ""),
      id: String(model.id ?? ""),
      name: String(model.name ?? model.id ?? "unknown"),
      available: true,
    }))
    .filter((model) => model.provider.length > 0 && model.id.length > 0);
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
    const payloadBudgetExtension = await resolvePayloadBudgetExtension();
    if (payloadBudgetExtension) args.push("--extension", payloadBudgetExtension);
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
    return loadNormalizedTranscriptMessages(this.sessionFile, messages);
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

  async getCommands(): Promise<readonly PiDynamicCommandInfo[]> {
    const data = await this.rpc.request("get_commands");
    const commands = isRecord(data) && Array.isArray(data.commands) ? data.commands : [];
    return sanitizePiDynamicCommands(commands.filter(isPiDynamicCommandInfo).map((command) => ({
      name: command.name,
      source: command.source,
      ...(typeof command.description === "string" ? { description: command.description } : {}),
      ...(command.location === "user" || command.location === "project" || command.location === "path" ? { location: command.location } : {}),
      ...(typeof command.path === "string" ? { path: command.path } : {}),
    })));
  }

  async runPiSlashCommand(text: string): Promise<void> {
    await this.rpc.request("prompt", { message: text });
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

  async getAvailableModels(): Promise<readonly ModelInfo[]> {
    const data = await this.rpc.request("get_available_models");
    const models = isRecord(data) && Array.isArray(data.models) ? data.models : [];
    return toModelInfo(models);
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

async function buildPiRpcArgs(options: {
  readonly sessionFile?: string;
  readonly sessionDir?: string;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
}): Promise<string[]> {
  const args = ["--mode", "rpc"];
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  if (options.sessionFile) args.push("--session", options.sessionFile);
  const payloadBudgetExtension = await resolvePayloadBudgetExtension();
  if (payloadBudgetExtension) args.push("--extension", payloadBudgetExtension);
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

async function resolvePayloadBudgetExtension(): Promise<string | undefined> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "extensions", "payload-budget-extension.ts"),
    path.join(here, "extensions", "payload-budget-extension.js"),
    path.resolve(process.cwd(), "src", "server", "pi", "extensions", "payload-budget-extension.ts"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* try next */ }
  }
  return undefined;
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

function isPiDynamicCommandInfo(value: unknown): value is PiDynamicCommandInfo {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string") return false;
  return value.source === "extension" || value.source === "prompt" || value.source === "skill";
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
