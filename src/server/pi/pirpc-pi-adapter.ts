import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
} from "./types.js";

export interface PiRpcAdapterOptions {
  readonly sessionDir?: string;
  readonly piCommand?: string;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
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
 * Pi adapter backed by `pi --mode rpc` subprocesses.
 *
 * Each hot session owns one RPC process. This keeps the app-level Pi boundary on
 * Pi's public JSONL protocol and lets the web UI consume the richer RPC event
 * stream, including tool_execution_* and extension_ui_request events.
 */
export class PiRpcAdapter implements PiAdapter {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly piCommand: string;

  constructor(private readonly options: PiRpcAdapterOptions = {}) {
    this.piCommand = options.piCommand ?? resolvePiCommand();
  }

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    const handle = await PiRpcSessionHandle.start({
      cwd: path.resolve(options.cwd),
      piCommand: this.piCommand,
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
    return PiRpcSessionHandle.start({
      cwd,
      sessionFile,
      piCommand: this.piCommand,
      ...(this.options.sessionDir === undefined ? {} : { sessionDir: this.options.sessionDir }),
      ...(this.options.extraArgs === undefined ? {} : { extraArgs: this.options.extraArgs }),
      ...(this.options.artifactExtension === undefined ? {} : { artifactExtension: this.options.artifactExtension }),
    });
  }

  async listSessions(cwd?: string): Promise<readonly SessionListItem[]> {
    const sessions = cwd === undefined
      ? await SessionManager.listAll()
      : await SessionManager.list(path.resolve(cwd), this.options.sessionDir);
    return sessions.map((item: any) => ({
      id: String(item.id),
      cwd: String(item.cwd ?? cwd ?? ""),
      sessionFile: String(item.path),
      ...(item.name === undefined ? {} : { sessionName: String(item.name) }),
      ...(item.firstMessage === undefined ? {} : { firstMessage: String(item.firstMessage) }),
      lastActivity: typeof item.timestamp === "number" ? item.timestamp : Date.parse(String(item.timestamp ?? Date.now())),
    }));
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

interface StartRpcSessionOptions {
  readonly cwd: string;
  readonly sessionFile?: string;
  readonly sessionDir?: string;
  readonly piCommand: string;
  readonly extraArgs?: readonly string[];
  readonly artifactExtension?: false | string;
}

class PiRpcSessionHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;

  private readonly rpc: JsonlRpcProcess;
  private readonly emitter = new EventEmitter();
  private latestState: Record<string, unknown>;
  private disposed = false;

  private constructor(rpc: JsonlRpcProcess, cwd: string, state: Record<string, unknown>) {
    this.rpc = rpc;
    this.cwd = cwd;
    this.latestState = state;
    this.id = String(state.sessionId ?? "");
    this.sessionFile = String(state.sessionFile ?? "");
    if (!this.id) throw new Error("Pi RPC session did not report a sessionId");
    if (!this.sessionFile) throw new Error("Pi RPC session did not report a sessionFile");

    this.rpc.onEvent((event) => {
      if (isRecord(event) && event.type === "extension_ui_request") {
        this.emitter.emit("event", event);
        return;
      }
      this.emitter.emit("event", event as PiEvent);
    });
  }

  static async start(options: StartRpcSessionOptions): Promise<PiRpcSessionHandle> {
    const args = ["--mode", "rpc"];
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.sessionFile) args.push("--session", options.sessionFile);
    const extension = await resolveArtifactExtension(options.artifactExtension);
    if (extension) args.push("--extension", extension);
    args.push(...(options.extraArgs ?? []));

    const rpc = new JsonlRpcProcess(options.piCommand, args, options.cwd);
    try {
      const state = await rpc.request("get_state");
      if (!isRecord(state)) throw new Error("Pi RPC get_state returned invalid data");
      return new PiRpcSessionHandle(rpc, options.cwd, state);
    } catch (error) {
      await rpc.dispose();
      throw error;
    }
  }

  async getState(): Promise<SessionState> {
    const data = await this.rpc.request("get_state");
    if (!isRecord(data)) throw new Error("Pi RPC get_state returned invalid data");
    this.latestState = data;
    return this.toState(data);
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

  async respondToExtensionUi(response: ExtensionUiResponse): Promise<void> {
    this.rpc.send({ type: "extension_ui_response", ...response });
  }

  subscribe(listener: PiEventListener): Unsubscribe {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.emitter.removeAllListeners();
    await this.rpc.dispose();
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

  private toState(state: Record<string, unknown>): SessionState {
    const model = isRecord(state.model) ? state.model : undefined;
    const stats = isRecord(state.stats) ? state.stats : undefined;
    const contextUsage = isRecord(state.contextUsage) ? state.contextUsage : undefined;
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
      totalTokens: sumNumbers(stats, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]),
      stats: {
        inputTokens: Number(stats?.inputTokens ?? stats?.input ?? 0),
        outputTokens: Number(stats?.outputTokens ?? stats?.output ?? 0),
        cacheReadTokens: Number(stats?.cacheReadTokens ?? stats?.cacheRead ?? 0),
        cacheWriteTokens: Number(stats?.cacheWriteTokens ?? stats?.cacheWrite ?? 0),
        cost: Number(stats?.cost ?? 0),
        contextTokens: numberOrNull(contextUsage?.tokens),
        contextPercent: numberOrNull(contextUsage?.percent),
        contextWindow: numberOrNull(contextUsage?.contextWindow ?? model?.contextWindow),
      },
      lastActivity: Date.now(),
    };
  }
}

class JsonlRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventEmitter = new EventEmitter();
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  private closed = false;

  constructor(command: string, args: readonly string[], cwd: string) {
    this.child = spawn(command, args, { cwd, stdio: "pipe", env: process.env });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`Pi RPC process exited (${signal ?? code ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
    });
  }

  onEvent(listener: (event: unknown) => void): Unsubscribe {
    this.eventEmitter.on("event", listener);
    return () => this.eventEmitter.off("event", listener);
  }

  send(payload: Record<string, unknown>): void {
    if (this.closed) throw new Error("Pi RPC process is closed");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  async request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new Error("Pi RPC process is closed");
    const id = `pirpc-${this.nextId++}`;
    const message = { id, type, ...payload };
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
    if (!response.success) throw new Error(response.error ?? `${type} failed`);
    return response.data;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Pi RPC process disposed"));
    this.pending.clear();
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 1_000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      this.receiveLine(line);
    }
  }

  private receiveLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.stderr = `${this.stderr}\n${line}`.slice(-16_000);
      return;
    }
    if (isRecord(parsed) && parsed.type === "response" && typeof parsed.id === "string") {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      pending.resolve(parsed as unknown as RpcResponse);
      return;
    }
    this.eventEmitter.emit("event", parsed);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function findSessionCwd(sessionFile: string, sessionDir?: string): Promise<string | undefined> {
  try {
    const sessions = await SessionManager.listAll();
    const match = sessions.find((item: any) => path.resolve(String(item.path)) === path.resolve(sessionFile));
    return match?.cwd === undefined ? undefined : String(match.cwd);
  } catch {
    return undefined;
  }
}

function resolvePiCommand(): string {
  const local = path.resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  return existsSync(local) ? local : "pi";
}

async function resolveArtifactExtension(configured: false | string | undefined): Promise<string | undefined> {
  if (configured === false) return undefined;
  if (typeof configured === "string") return path.resolve(configured);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "extensions", "pi-remote-artifacts.ts"),
    path.join(here, "extensions", "pi-remote-artifacts.js"),
    path.resolve(process.cwd(), "src", "server", "pi", "extensions", "pi-remote-artifacts.ts"),
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

function toSessionMessages(messages: readonly unknown[]): SessionMessage[] {
  const result: SessionMessage[] = [];
  const toolCallIndexes = new Map<string, number>();

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = String(message.role ?? "");
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();

    if (role === "assistant") {
      const text = contentText(message.content).trim();
      if (text) result.push({ role: "assistant", content: text, timestamp });

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

function contentTextAndImages(content: unknown): { text: string; images: NonNullable<SessionMessage["images"]> } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content === undefined ? "" : JSON.stringify(content), images: [] };
  const text: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") text.push(block.text);
    if (typeof block.thinking === "string") text.push(block.thinking);
    if (block.type === "image" && typeof block.data === "string") {
      images.push({ data: block.data, mimeType: String(block.mimeType ?? "image/png") });
    }
  }
  return { text: text.join("\n"), images };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumNumbers(record: Record<string, unknown> | undefined, keys: readonly string[]): number {
  if (!record) return 0;
  return keys.reduce((sum, key) => sum + Number(record[key] ?? 0), 0);
}
