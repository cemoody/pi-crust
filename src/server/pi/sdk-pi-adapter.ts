import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
} from "./types.js";

export interface SdkPiAdapterOptions {
  readonly sessionDir?: string;
}

/**
 * Thin SDK boundary. The rest of the app should depend on PiAdapter, not on Pi SDK types.
 */
export class SdkPiAdapter implements PiAdapter {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly settingsManager = SettingsManager.create(process.cwd());
  private readonly sessionNames: SessionNameStore;

  constructor(private readonly options: SdkPiAdapterOptions = {}) {
    this.sessionNames = new SessionNameStore(options.sessionDir);
  }

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    const cwd = path.resolve(options.cwd);
    const { session } = await createAgentSession({
      cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      sessionManager: SessionManager.create(cwd, this.options.sessionDir),
    });
    const handle = new SdkPiSessionHandle(session, cwd, this.modelRegistry, this.sessionNames);
    if (options.sessionName) {
      await handle.setSessionName(options.sessionName);
    }
    return handle;
  }

  async openSession(options: OpenSessionOptions): Promise<PiSessionHandle> {
    const { session } = await createAgentSession({
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      sessionManager: SessionManager.open(options.sessionFile, this.options.sessionDir),
    });
    const sdkSession = session as any;
    const cwd = String(sdkSession.sessionManager?.getCwd?.() ?? sdkSession.cwd ?? process.cwd());
    return new SdkPiSessionHandle(session, cwd, this.modelRegistry, this.sessionNames);
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

  async listSessions(cwd?: string): Promise<readonly SessionListItem[]> {
    const sessions = cwd === undefined
      ? await SessionManager.listAll()
      : await SessionManager.list(path.resolve(cwd), this.options.sessionDir);
    return Promise.all(sessions.map(async (item: any) => {
      const id = String(item.id);
      const sessionFile = String(item.path);
      const storedName = await this.sessionNames.get(id, sessionFile);
      const sessionName = item.name === undefined ? storedName : String(item.name);
      return {
        id,
        cwd: String(item.cwd ?? cwd ?? ""),
        sessionFile,
        ...(sessionName === undefined ? {} : { sessionName }),
        ...(item.firstMessage === undefined ? {} : { firstMessage: String(item.firstMessage) }),
        lastActivity: typeof item.timestamp === "number" ? item.timestamp : Date.parse(String(item.timestamp ?? Date.now())),
      };
    }));
  }
}

class SdkPiSessionHandle implements PiSessionHandle {
  readonly id: string;
  readonly sessionFile: string;

  constructor(
    private readonly session: any,
    readonly cwd: string,
    private readonly modelRegistry: any,
    private readonly sessionNames: SessionNameStore,
  ) {
    this.id = String(session.sessionId);
    this.sessionFile = String(session.sessionFile ?? session.sessionManager?.getSessionFile?.() ?? "");
  }

  async getState(): Promise<SessionState> {
    const sdkModel = this.session.model;
    const messages: any[] = Array.isArray(this.session.messages) ? this.session.messages : [];
    const aggregated = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const message of messages) {
      const usage = message?.usage;
      if (!usage) continue;
      aggregated.input += Number(usage.input ?? 0);
      aggregated.output += Number(usage.output ?? 0);
      aggregated.cacheRead += Number(usage.cacheRead ?? 0);
      aggregated.cacheWrite += Number(usage.cacheWrite ?? 0);
      aggregated.cost += Number(usage?.cost?.total ?? 0);
    }
    const totalTokens = aggregated.input + aggregated.output + aggregated.cacheRead + aggregated.cacheWrite;

    let contextTokens: number | null = null;
    let contextPercent: number | null = null;
    let contextWindow: number | null = sdkModel?.contextWindow ? Number(sdkModel.contextWindow) : null;
    try {
      if (typeof this.session.getSessionStats === "function") {
        const live = await this.session.getSessionStats();
        const ctx = live?.contextUsage;
        if (ctx) {
          if (typeof ctx.tokens === "number") contextTokens = ctx.tokens;
          if (typeof ctx.percent === "number") contextPercent = Math.round(ctx.percent);
          if (typeof ctx.contextWindow === "number") contextWindow = ctx.contextWindow;
        }
      }
    } catch {
      // optional; ignore failures
    }

    const sessionName = this.session.sessionName === undefined
      ? await this.sessionNames.get(this.id, this.sessionFile)
      : String(this.session.sessionName);

    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      status: this.session.isStreaming ? "running" : "idle",
      ...(sessionName === undefined ? {} : { sessionName }),
      ...(sdkModel ? { modelProvider: String(sdkModel.provider ?? ""), model: String(sdkModel.id ?? "") } : {}),
      messageCount: messages.length,
      totalTokens,
      stats: {
        inputTokens: aggregated.input,
        outputTokens: aggregated.output,
        cacheReadTokens: aggregated.cacheRead,
        cacheWriteTokens: aggregated.cacheWrite,
        cost: aggregated.cost,
        contextTokens,
        contextPercent,
        contextWindow,
      },
      lastActivity: Date.now(),
    };
  }

  async setModel(provider: string, modelId: string): Promise<SessionState> {
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.session.setModel(model);
    return this.getState();
  }

  async setSessionName(name: string): Promise<SessionState> {
    if (typeof this.session.setSessionName !== "function") {
      throw new Error("Pi SDK session does not support renaming sessions");
    }
    this.session.setSessionName(name);
    await this.sessionNames.set(this.id, this.sessionFile, name);
    return this.getState();
  }

  async getMessages(): Promise<readonly SessionMessage[]> {
    const messages = Array.isArray(this.session.messages) ? this.session.messages : [];
    const result: SessionMessage[] = [];
    for (const message of messages) {
      const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
      if (message.role === "assistant") {
        const blocks: any[] = Array.isArray(message.content) ? message.content : [];
        const text = blocks
          .filter((block) => block?.type === "text")
          .map((block) => String(block.text ?? ""))
          .join("\n")
          .trim();
        if (text) result.push({ role: "assistant", content: text, timestamp });
        for (const block of blocks) {
          if (block?.type === "toolCall") {
            result.push({
              role: "tool",
              content: "",
              timestamp,
              tool: {
                id: String(block.id ?? ""),
                name: String(block.name ?? ""),
                args: (block.arguments ?? {}) as Record<string, unknown>,
                status: "running",
                output: "",
              },
            });
          }
        }
      } else if (message.role === "toolResult") {
        const output = stringifyContent(message.content);
        const toolCallId = String(message.toolCallId ?? "");
        for (let i = result.length - 1; i >= 0; i--) {
          const previous = result[i];
          if (previous && previous.role === "tool" && previous.tool && previous.tool.id === toolCallId) {
            result[i] = {
              ...previous,
              tool: {
                ...previous.tool,
                status: message.isError ? "error" : "success",
                output,
              },
            };
            break;
          }
        }
      } else if (message.role === "user" || message.role === "system") {
        const blocks: any[] = Array.isArray(message.content) ? message.content : [];
        const text = typeof message.content === "string"
          ? message.content
          : blocks.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("\n");
        const images = blocks
          .filter((block) => block?.type === "image")
          .map((block) => ({
            data: String(block.data ?? ""),
            mimeType: String(block.mimeType ?? "image/png"),
          }))
          .filter((image) => image.data.length > 0);
        result.push({
          role: message.role,
          content: text,
          timestamp,
          ...(images.length > 0 ? { images } : {}),
        });
      }
    }
    return result;
  }

  async prompt(message: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    const images = attachments
      .filter((attachment) => attachment.type === "image" && attachment.data)
      .map((attachment) => ({
        type: "image" as const,
        data: attachment.data!,
        mimeType: attachment.mimeType ?? "image/png",
      }));
    await this.session.prompt(message, images.length > 0 ? { images } : undefined);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async getLastAssistantText(): Promise<string | null> {
    if (typeof this.session.getLastAssistantText === "function") return this.session.getLastAssistantText();
    const messages = await this.getMessages();
    return [...messages].reverse().find((message) => message.role === "assistant")?.content ?? null;
  }

  async getCommands() {
    const commands = typeof this.session.getCommands === "function" ? this.session.getCommands() : [];
    return commands.map((command: any) => ({
      name: String(command.name ?? command.invocationName ?? ""),
      ...(command.description === undefined ? {} : { description: String(command.description) }),
      source: command.source === "skill" ? "skill" as const : command.source === "prompt" ? "prompt" as const : "extension" as const,
    })).filter((command: { name: string }) => command.name.length > 0);
  }

  async compact(customInstructions?: string) {
    if (typeof this.session.compact !== "function") throw new Error("Pi SDK session does not support compaction");
    const result = await this.session.compact(customInstructions);
    return {
      summary: String(result?.summary ?? "Compaction complete"),
      ...(typeof result?.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}),
    };
  }

  async getTree() {
    return this.treeFromSessionManager();
  }

  async setTreeLabel(entryId: string, label: string | undefined) {
    const manager = this.session.sessionManager;
    if (manager && typeof manager.appendLabelChange === "function") manager.appendLabelChange(entryId, label);
    return this.treeFromSessionManager();
  }

  async navigateTree(entryId: string, options: { readonly summary: "none" | "default" | "custom"; readonly customInstructions?: string }) {
    if (typeof this.session.navigateTree !== "function") throw new Error("Pi SDK session does not support tree navigation");
    const result = await this.session.navigateTree(entryId, {
      summarize: options.summary !== "none",
      ...(options.customInstructions ? { customInstructions: options.customInstructions } : {}),
    });
    return { ...(result?.editorText === undefined ? {} : { editorText: String(result.editorText) }), tree: await this.getTree() };
  }

  private treeFromSessionManager() {
    const manager = this.session.sessionManager;
    const entries: any[] = typeof manager?.getEntries === "function" ? manager.getEntries() : [];
    const currentLeafId = typeof manager?.getLeafId === "function" ? manager.getLeafId() : null;
    return {
      currentLeafId: currentLeafId ? String(currentLeafId) : null,
      entries: entries.map((entry) => ({
        id: String(entry.id),
        parentId: entry.parentId === null || entry.parentId === undefined ? null : String(entry.parentId),
        role: entry.type === "message" && entry.message?.role === "assistant" ? "assistant" as const
          : entry.type === "message" && entry.message?.role === "user" ? "user" as const
            : entry.type === "message" && entry.message?.role === "toolResult" ? "tool" as const
              : entry.type === "compaction" || entry.type === "branch_summary" ? "summary" as const
                : "custom" as const,
        text: entry.type === "message" ? stringifyContent(entry.message?.content) : String(entry.summary ?? entry.type ?? ""),
        ...(typeof manager?.getLabel === "function" && manager.getLabel(entry.id) ? { label: String(manager.getLabel(entry.id)) } : {}),
      })),
    };
  }

  subscribe(listener: PiEventListener): Unsubscribe {
    return this.session.subscribe(listener as any);
  }

  async dispose(): Promise<void> {
    this.session.dispose();
  }
}

interface PersistedSessionNames {
  readonly byId?: Record<string, string>;
  readonly byFile?: Record<string, string>;
}

class SessionNameStore {
  private readonly file: string;

  constructor(sessionDir?: string) {
    const root = path.resolve(sessionDir ?? path.join(os.homedir(), ".pi", "agent", "sessions"));
    this.file = path.join(root, ".pi-remote-session-names.json");
  }

  async get(sessionId: string, sessionFile: string): Promise<string | undefined> {
    const data = await this.read();
    return data.byId?.[sessionId] ?? data.byFile?.[sessionFile];
  }

  async set(sessionId: string, sessionFile: string, name: string): Promise<void> {
    const trimmed = name.trim();
    const current = await this.read();
    const byId = { ...(current.byId ?? {}) };
    const byFile = { ...(current.byFile ?? {}) };
    if (trimmed) {
      byId[sessionId] = trimmed;
      if (sessionFile) byFile[sessionFile] = trimmed;
    } else {
      delete byId[sessionId];
      if (sessionFile) delete byFile[sessionFile];
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify({ byId, byFile }, null, 2)}\n`, "utf8");
  }

  private async read(): Promise<PersistedSessionNames> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as PersistedSessionNames;
    } catch {
      return {};
    }
  }
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") return b.text;
        if (typeof b.thinking === "string") return b.thinking;
        if (b.type === "image") return ""; // image blocks surface via the images field, not text
        if (b.type === "toolCall") return "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined ? "" : "";
}
