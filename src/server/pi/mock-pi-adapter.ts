import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
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
  SessionListItem,
  SessionMessage,
  SessionState,
  SessionStatus,
  Unsubscribe,
} from "./types.js";
import type { ExtensionUiRequest } from "../../shared/protocol.js";

import { optional } from "../../shared/util.js";
interface PersistedMockSession {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly sessionName?: string;
  readonly messages: readonly SessionMessage[];
  readonly lastActivity: number;
}

export interface MockPiAdapterOptions {
  readonly sessionRoot: string;
  readonly assistantResponse?: (prompt: string) => string;
  readonly models?: readonly ModelInfo[];
}

const DEFAULT_MOCK_MODELS: readonly ModelInfo[] = [
  { provider: "mock", id: "mock-echo", name: "Mock Echo", available: true },
  { provider: "mock", id: "mock-loud", name: "Mock Loud", available: true },
];

export class MockPiAdapter implements PiAdapter {
  private readonly sessionRoot: string;
  private readonly assistantResponse: (prompt: string) => string;
  private readonly models: readonly ModelInfo[];

  constructor(options: MockPiAdapterOptions) {
    this.sessionRoot = path.resolve(options.sessionRoot);
    this.assistantResponse = options.assistantResponse ?? ((prompt) => `Mock response to: ${prompt}`);
    this.models = options.models ?? DEFAULT_MOCK_MODELS;
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models;
  }

  async forkSession(source: PiSessionHandle, entryId: string): Promise<{ readonly result: ForkSessionResult; readonly handle: PiSessionHandle }> {
    if (!(source instanceof MockPiSessionHandle)) throw new Error("MockPiAdapter can only fork mock sessions");
    return source.createFork(entryId);
  }

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    await fs.mkdir(this.sessionRoot, { recursive: true });
    const id = crypto.randomUUID();
    const sessionFile = path.join(this.sessionRoot, `${Date.now()}_${id}.mock-session.json`);
    const persisted: PersistedMockSession = {
      id,
      cwd: path.resolve(options.cwd),
      sessionFile,
      ...optional({ sessionName: options.sessionName }),
      messages: [],
      lastActivity: Date.now(),
    };
    await writeSession(persisted);
    return new MockPiSessionHandle(persisted, this.sessionRoot, this.assistantResponse);
  }

  async openSession(options: OpenSessionOptions): Promise<PiSessionHandle> {
    const persisted = await readSession(path.resolve(options.sessionFile));
    return new MockPiSessionHandle(persisted, this.sessionRoot, this.assistantResponse);
  }

  async listSessions(cwd?: string): Promise<readonly SessionListItem[]> {
    await fs.mkdir(this.sessionRoot, { recursive: true });
    const entries = await fs.readdir(this.sessionRoot);
    const items: SessionListItem[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".mock-session.json") && !entry.endsWith(".jsonl")) continue;
      const sessionFile = path.join(this.sessionRoot, entry);
      const persisted = await readSession(sessionFile);
      if (cwd !== undefined && persisted.cwd !== path.resolve(cwd)) continue;
      const firstMessage = persisted.messages.find((message) => message.role === "user")?.content;
      items.push({
        id: persisted.id,
        cwd: persisted.cwd,
        sessionFile: persisted.sessionFile,
        ...optional({ sessionName: persisted.sessionName }),
        ...optional({ firstMessage }),
        lastActivity: persisted.lastActivity,
      });
    }
    return items.sort((a, b) => b.lastActivity - a.lastActivity);
  }
}

class MockPiSessionHandle implements PiSessionHandle {
  id: string;
  cwd: string;
  sessionFile: string;

  private readonly emitter = new EventEmitter();
  private status: SessionStatus = "idle";
  private sessionName: string | undefined;
  private modelProvider: string | undefined;
  private modelId: string | undefined;
  private messages: SessionMessage[];
  private lastActivity: number;
  private readonly assistantResponse: (prompt: string) => string;
  private readonly sessionRoot: string;

  constructor(persisted: PersistedMockSession, sessionRoot: string, assistantResponse: (prompt: string) => string) {
    this.id = persisted.id;
    this.cwd = persisted.cwd;
    this.sessionFile = persisted.sessionFile;
    this.sessionName = persisted.sessionName;
    this.messages = [...persisted.messages];
    this.lastActivity = persisted.lastActivity;
    this.sessionRoot = sessionRoot;
    this.assistantResponse = assistantResponse;
  }

  async getState(): Promise<SessionState> {
    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      status: this.status,
      ...optional({ sessionName: this.sessionName }),
      ...(this.modelProvider && this.modelId
        ? { modelProvider: this.modelProvider, model: `${this.modelProvider}/${this.modelId}` }
        : {}),
      messageCount: this.messages.length,
      totalTokens: 0,
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        contextTokens: 0,
        contextPercent: 0,
        contextWindow: 200_000,
      },
      lastActivity: this.lastActivity,
    };
  }

  async setModel(provider: string, modelId: string): Promise<SessionState> {
    this.modelProvider = provider;
    this.modelId = modelId;
    this.lastActivity = Date.now();
    await this.persist();
    return this.getState();
  }

  async setSessionName(name: string): Promise<SessionState> {
    const trimmed = name.trim();
    this.sessionName = trimmed || undefined;
    this.lastActivity = Date.now();
    await this.persist();
    return this.getState();
  }

  async getMessages(): Promise<readonly SessionMessage[]> {
    return [...this.messages];
  }

  async getForkMessages(): Promise<readonly ForkMessage[]> {
    return this.messages.flatMap((message, index) => message.role === "user"
      ? [{ entryId: mockEntryId(message, index), text: message.content }]
      : []);
  }

  async fork(entryId: string): Promise<ForkSessionResult> {
    const { result, handle } = await this.createFork(entryId);
    if (!result.cancelled) {
      const fork = await readSession(handle.sessionFile);
      this.id = fork.id;
      this.cwd = fork.cwd;
      this.sessionFile = fork.sessionFile;
      this.sessionName = fork.sessionName;
      this.messages = [...fork.messages];
      this.lastActivity = fork.lastActivity;
    }
    return result;
  }

  async createFork(entryId: string): Promise<{ readonly result: ForkSessionResult; readonly handle: MockPiSessionHandle }> {
    const index = this.findForkMessageIndex(entryId);
    if (index === -1) throw new Error(`Unknown fork entry: ${entryId}`);
    const selected = this.messages[index]!;
    const persisted = await this.persistedCopy(
      this.messages.slice(0, index),
      `Fork of ${this.sessionName ?? shortId(this.id)}`,
    );
    return {
      result: { cancelled: false, text: selected.content },
      handle: new MockPiSessionHandle(persisted, this.sessionRoot, this.assistantResponse),
    };
  }

  async clone(): Promise<CloneSessionResult> {
    await this.replaceWithMessages([...this.messages], `Clone of ${this.sessionName ?? shortId(this.id)}`);
    return { cancelled: false };
  }

  async prompt(message: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    // Test/load directive: `@@burst <intervalMs> <durationMs>` drives a
    // sustained synthetic token stream (one text_delta every intervalMs for
    // durationMs) without any LLM. Used by the multi-tab pressure test to
    // prove concurrent, long-lived streaming + per-session isolation.
    const burst = /^@@burst\s+(\d+)\s+(\d+)\s*$/.exec(message.trim());
    if (burst) {
      await this.runBurst(Number(burst[1]), Number(burst[2]));
      return;
    }
    // Test directive: `@@artifact` emits a LIVE image artifact exactly the way
    // the @cemoody/pi-artifact `display(...)` tool does in production: it writes
    // a real PNG under <cwd>/.pi/artifacts/<sessionId>/ and emits a paired
    // message_start/message_end carrying a `role: "custom"`, `customType:
    // "artifact"` WireMessage whose image src is the extension-served URL
    // /api/sessions/:id/artifacts/:file. Used by artifact-live-render.spec.ts to
    // prove the artifact renders AND its bytes load without a page reload
    // (the PR #204 realtime-reducer + PR #205 byte-serving paths combined).
    if (message.trim() === "@@artifact") {
      await this.runArtifact();
      return;
    }
    // Test directive: `@@extension-ui` emits generic extension UI status/widget
    // requests exactly as RPC-backed extensions do for ctx.ui.setStatus and
    // ctx.ui.setWidget. Used by extension-ui-generic.spec.ts to pin the web
    // renderer without depending on a specific third-party extension.
    if (message.trim() === "@@extension-ui") {
      await this.runExtensionUiDemo(message);
      return;
    }
    // Test directive: `@@login` reproduces the browser-extension login handoff —
    // the LLM explains it needs a sign-in, then calls `browser_request_login`,
    // whose result carries a `kind:"html"` artifact rendered as an inline live
    // browser card (Tier-B reveal) right in the conversation turn.
    if (message.trim() === "@@login") {
      await this.runLoginHandoff(message);
      return;
    }
    this.status = "running";
    this.emit({ type: "agent_start" });
    const timestamp = Date.now();
    const images = attachments
      .filter((attachment) => attachment.type === "image" && attachment.data)
      .map((attachment) => ({
        data: attachment.data!,
        mimeType: attachment.mimeType ?? "image/png",
      }));
    const userMessage: SessionMessage = {
      role: "user",
      content: message,
      timestamp,
      ...(images.length > 0 ? { images } : {}),
    };
    this.messages.push(userMessage);
    this.lastActivity = Date.now();
    this.emit({ type: "message", message: userMessage });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const assistantBody = images.length > 0
      ? `Got ${images.length} image attachment${images.length === 1 ? "" : "s"} (${images.map((image) => `${image.mimeType}, ${image.data.length} chars`).join("; ")}). ${this.assistantResponse(message)}`
      : this.assistantResponse(message);
    const assistantMessage: SessionMessage = {
      role: "assistant",
      content: assistantBody,
      timestamp: timestamp + 1,
    };
    this.messages.push(assistantMessage);
    this.lastActivity = Date.now();
    this.emit({ type: "message", message: assistantMessage });
    await this.persist();
    this.status = "idle";
    this.emit({ type: "agent_end", messages: [userMessage, assistantMessage] });
  }

  private async runLoginHandoff(message: string): Promise<void> {
    this.status = "running";
    this.emit({ type: "agent_start" });
    const t = Date.now();
    const userMessage: SessionMessage = { role: "user", content: message, timestamp: t };
    this.messages.push(userMessage);
    this.emit({ type: "message", message: userMessage });
    await new Promise((r) => setTimeout(r, 40));

    const assistantMessage: SessionMessage = {
      role: "assistant",
      content:
        "I need to access your private GitHub repos, but you're not signed in. " +
        "I've opened the GitHub login page in the live browser below \u2014 please " +
        "enter your username and password, then I'll continue.",
      timestamp: t + 1,
    };
    this.messages.push(assistantMessage);
    this.emit({ type: "message", message: assistantMessage });
    await new Promise((r) => setTimeout(r, 40));

    // The live browser card. Emitted as a persisted custom "artifact" message
    // with a text/html representation (rendered inline as a sandboxed
    // allow-scripts iframe), so it survives the post-turn /messages refetch.
    // The embedded canvas connects to the browser stream server over WebSocket.
    const wsUrl = process.env.PI_CRUST_BROWSER_WS ?? "ws://127.0.0.1:4000";
    const viewerHtml = [
      "<!doctype html><meta charset=utf8>",
      "<style>html,body{margin:0;height:100%;background:#15151a;font:12px system-ui;color:#ddd}",
      ".bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #333}",
      ".dot{width:8px;height:8px;border-radius:50%;background:#3c6;display:inline-block}",
      "#u{opacity:.75;font-family:ui-monospace,monospace}",
      ".wrap{display:flex;align-items:center;justify-content:center;padding:6px}",
      "canvas{max-width:100%;max-height:460px;background:#fff;cursor:crosshair;box-shadow:0 0 0 1px #333}</style>",
      "<div class=bar><span class=dot></span><b>\uD83C\uDF10 Browser</b><span id=u>connecting\u2026</span></div>",
      "<div class=wrap><canvas id=c width=1280 height=800 tabindex=0></canvas></div>",
      "<script>",
      "var c=document.getElementById('c'),x=c.getContext('2d'),u=document.getElementById('u'),w=1280,h=800;",
      "var ws=new WebSocket('" + wsUrl + "');",
      "ws.onopen=function(){u.textContent='live';};",
      "ws.onmessage=function(e){var m=JSON.parse(e.data);",
      " if(m.type==='frame'){var i=new Image();i.onload=function(){if(c.width!==m.w){c.width=m.w;c.height=m.h;}w=m.w;h=m.h;x.drawImage(i,0,0,m.w,m.h);};i.src='data:image/jpeg;base64,'+m.data;}",
      " else if(m.type==='meta'&&m.url){u.textContent=m.url;}};",
      "function pt(ev){var r=c.getBoundingClientRect();return{x:Math.round((ev.clientX-r.left)*(w/r.width)),y:Math.round((ev.clientY-r.top)*(h/r.height))};}",
      "function snd(o){if(ws.readyState===1)ws.send(JSON.stringify(o));}",
      "c.addEventListener('mousedown',function(e){var p=pt(e);snd({kind:'mouse',type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});c.focus();});",
      "c.addEventListener('mouseup',function(e){var p=pt(e);snd({kind:'mouse',type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});});",
      "c.addEventListener('keydown',function(e){snd({kind:'key',type:'keyDown',key:e.key,code:e.code,text:e.key.length===1?e.key:undefined});e.preventDefault();});",
      "<\/script>",
    ].join("\n");

    const groupId = crypto.randomBytes(8).toString("hex");
    const artifactMessage = {
      role: "custom" as const,
      content: "browser_request_login: Sign in to GitHub to continue",
      timestamp: Date.now(),
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: groupId,
        caption: "\uD83D\uDD10 Sign in to GitHub \u2014 the agent is waiting for you to log in",
        artifacts: [
          { mime: "text/html", html: viewerHtml, height: 520 },
          { mime: "text/plain", text: "Live GitHub login \u2014 sign in to continue" },
        ],
      },
    };
    this.messages.push(artifactMessage as unknown as SessionMessage);
    await this.persist();
    this.emit({ type: "message_start", message: artifactMessage } as unknown as PiEvent);
    await new Promise((r) => setTimeout(r, 30));
    this.emit({ type: "message_end", message: artifactMessage } as unknown as PiEvent);
    this.status = "idle";
    this.lastActivity = Date.now();
    this.emit({ type: "agent_end", messages: [] });
  }

  private async runExtensionUiDemo(message: string): Promise<void> {
    this.status = "running";
    this.emit({ type: "agent_start" });
    const timestamp = Date.now();
    const userMessage: SessionMessage = { role: "user", content: message, timestamp };
    this.messages.push(userMessage);
    this.emit({ type: "message", message: userMessage });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const extensionUiRequests = [
      { id: "status-loop", method: "setStatus", statusKey: "loop", statusText: "⟳ loop · 1 active" },
      { id: "status-review", method: "setStatus", statusKey: "review", statusText: "review · waiting" },
      {
        id: "widget-loop",
        method: "setWidget",
        widgetKey: "loop",
        widgetLines: [
          "⟳ #3 Read /home/coder/PROMPT_roofing_dma_pipeline_orchestrator.md — cron: */5 * * * * · next 4m28s 4/500",
        ],
      },
      {
        id: "widget-audit",
        method: "setWidget",
        widgetKey: "audit",
        widgetLines: [
          "finding JSONs: 4/5",
          "finding MDs: 4/5",
          "corrected/artifact files: 22",
        ],
      },
    ] satisfies ExtensionUiRequest[];

    const assistantMessage: SessionMessage = {
      role: "assistant",
      content: "Emitted generic extension UI demo requests.",
      timestamp: timestamp + 1,
    };
    this.messages.push(assistantMessage);
    await this.persist();
    this.status = "idle";
    this.lastActivity = Date.now();
    this.emit({ type: "message", message: assistantMessage });
    this.emit({ type: "agent_end", messages: [userMessage, assistantMessage] });
    for (const delayMs of [50, 250, 750, 1500]) {
      setTimeout(() => {
        for (const request of extensionUiRequests) {
          this.emit({ type: "extension_ui_request", ...request } as PiEvent);
        }
      }, delayMs).unref?.();
    }
  }

  private async runBurst(intervalMs: number, durationMs: number): Promise<void> {
    this.status = "running";
    this.lastActivity = Date.now();
    this.emit({ type: "agent_start" });
    const start = Date.now();
    let ticks = 0;
    while (Date.now() - start < durationMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, intervalMs)));
      ticks += 1;
      this.lastActivity = Date.now();
      this.emit({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: `tick-${ticks}` },
      } as PiEvent);
    }
    const assistantMessage: SessionMessage = {
      role: "assistant",
      content: `burst complete: ${ticks} ticks over ${durationMs}ms`,
      timestamp: Date.now(),
    };
    this.messages.push(assistantMessage);
    this.lastActivity = Date.now();
    await this.persist();
    this.status = "idle";
    this.emit({ type: "agent_end", messages: [assistantMessage] });
  }

  private async runArtifact(): Promise<void> {
    this.status = "running";
    this.lastActivity = Date.now();
    this.emit({ type: "agent_start" });

    // Write a real 2x2 PNG so naturalWidth becomes 2 once the bytes load.
    const groupId = crypto.randomBytes(8).toString("hex");
    const fileName = `${groupId}.png`;
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNkYPj/n4EIwDiqEAAlMQMG0V8XdQAAAABJRU5ErkJggg==";
    const artifactDir = path.join(this.cwd, ".pi", "artifacts", this.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, fileName), Buffer.from(pngBase64, "base64"));

    const timestamp = Date.now();
    const url = `/api/sessions/${encodeURIComponent(this.id)}/artifacts/${fileName}`;
    const artifactMessage = {
      role: "custom" as const,
      content: `live-artifact.png (live-artifact.png, 0.1 KB)`,
      timestamp,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: groupId,
        caption: "Live artifact render",
        artifacts: [
          { mime: "image/png", src: { kind: "url", url }, alt: "live artifact demo image" },
          { mime: "text/plain", text: "Live artifact render" },
        ],
      },
    };
    // Persist the artifact (production-faithful: the display tool writes a
    // custom_message line to the jsonl) so it survives the scheduled /messages
    // refetch that message_end/agent_end trigger, AND emit the live paired
    // events exactly as sendCustomMessage does. The combination exercises both
    // the live reducer and the byte-serving route end to end.
    this.messages.push(artifactMessage as unknown as SessionMessage);
    await this.persist();
    this.emit({ type: "message_start", message: artifactMessage } as unknown as PiEvent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    this.emit({ type: "message_end", message: artifactMessage } as unknown as PiEvent);

    this.status = "idle";
    this.lastActivity = Date.now();
    this.emit({ type: "agent_end", messages: [] });
  }

  async abort(): Promise<void> {
    this.status = "idle";
    this.lastActivity = Date.now();
    await this.persist();
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.status = "compacting";
    this.emit({ type: "compaction_start", reason: "manual" });
    const timestamp = Date.now();
    const summary = customInstructions?.trim()
      ? `Mock compaction summary (${customInstructions.trim()})`
      : "Mock compaction summary";
    const message: SessionMessage = { role: "summary", summaryKind: "compaction", content: summary, timestamp };
    this.messages.push(message);
    this.lastActivity = timestamp;
    await this.persist();
    this.status = "idle";
    const result = { summary, firstKeptEntryId: `${timestamp}-mock`, tokensBefore: 0, details: {} };
    this.emit({ type: "compaction_end", reason: "manual", result, aborted: false });
    return result;
  }

  async reload(): Promise<SessionState> {
    this.lastActivity = Date.now();
    await this.persist();
    this.emit({ type: "session_reload", reason: "manual" } as unknown as PiEvent);
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
    this.emitter.emit("event", event);
  }

  private findForkMessageIndex(entryId: string): number {
    return this.messages.findIndex((message, index) => message.role === "user" && mockEntryId(message, index) === entryId);
  }

  private async replaceWithMessages(messages: SessionMessage[], sessionName: string): Promise<void> {
    const persisted = await this.persistedCopy(messages, sessionName);
    this.id = persisted.id;
    this.sessionFile = persisted.sessionFile;
    this.messages = [...persisted.messages];
    this.sessionName = persisted.sessionName;
    this.lastActivity = persisted.lastActivity;
  }

  private async persistedCopy(messages: readonly SessionMessage[], sessionName: string): Promise<PersistedMockSession> {
    const id = crypto.randomUUID();
    const persisted: PersistedMockSession = {
      id,
      cwd: this.cwd,
      sessionFile: path.join(this.sessionRoot, `${Date.now()}_${id}.mock-session.json`),
      messages: [...messages],
      sessionName,
      lastActivity: Date.now(),
    };
    await writeSession(persisted);
    return persisted;
  }

  private async persist(): Promise<void> {
    await writeSession({
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      ...optional({ sessionName: this.sessionName }),
      messages: this.messages,
      lastActivity: this.lastActivity,
    });
  }
}

function mockEntryId(message: SessionMessage, index: number): string {
  return `${message.timestamp}-${index}`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

async function readSession(sessionFile: string): Promise<PersistedMockSession> {
  const raw = await fs.readFile(sessionFile, "utf8");
  // Test-infra affordance: a real on-disk pirpc/Anthropic `.jsonl`
  // transcript can be dropped into the mock session root so Playwright
  // can exercise the production tail-read code path
  // (readSessionMessagesTail + the toSessionMessages fan-out) instead of
  // the mock's pre-shaped in-memory messages. We only need enough
  // metadata to register the session; the actual messages are served by
  // the HTTP /messages tail-read straight from this file.
  if (sessionFile.endsWith(".jsonl")) return readJsonlSessionHeader(sessionFile, raw);
  return JSON.parse(raw) as PersistedMockSession;
}

function readJsonlSessionHeader(sessionFile: string, raw: string): PersistedMockSession {
  let id = path.basename(sessionFile, ".jsonl");
  let cwd = path.dirname(sessionFile);
  let sessionName: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "session") {
        if (typeof entry.id === "string") id = entry.id;
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.sessionName === "string") sessionName = entry.sessionName;
        break;
      }
    } catch {
      // Ignore non-JSON lines; the header is normally the first record.
    }
  }
  return {
    id,
    cwd: path.resolve(cwd),
    sessionFile,
    ...optional({ sessionName }),
    messages: [],
    lastActivity: Date.now(),
  };
}

async function writeSession(session: PersistedMockSession): Promise<void> {
  await fs.mkdir(path.dirname(session.sessionFile), { recursive: true });
  await fs.writeFile(session.sessionFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}
