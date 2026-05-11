import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
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

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("HTTP API SSE streaming", () => {
  it("flushes session events while the prompt request is still in flight", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-remote-sse-test-"));
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    await fs.mkdir(projectRoot, { recursive: true });
    const promptGate = deferred<void>();
    const adapter = new StreamingTestAdapter(sessionRoot, promptGate.promise);
    const registry = new SessionRegistry({
      adapter,
      pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    });
    const created = await registry.createSession({ cwd: projectRoot });
    const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
    servers.push(server);
    const baseUrl = await listen(server);

    const controller = new AbortController();
    const eventResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/events`, { signal: controller.signal });
    expect(eventResponse.ok).toBe(true);
    const reader = createSseReader(eventResponse);
    await reader.nextJson(); // ready event

    let promptResolved = false;
    const promptRequest = fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "stream please" }),
    }).then(async (response) => {
      promptResolved = true;
      expect(response.ok).toBe(true);
      return response.json();
    });

    const agentStart = await reader.nextJson((event) => event.type === "agent_start");
    expect(agentStart).toMatchObject({ type: "agent_start" });
    expect(promptResolved).toBe(false);

    const textDelta = await reader.nextJson((event) => event.type === "message_update");
    expect(textDelta).toMatchObject({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "streamed before prompt resolved" },
    });
    expect(promptResolved).toBe(false);

    promptGate.resolve();
    const promptMessages = await promptRequest;
    expect(promptResolved).toBe(true);
    expect(promptMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "done" })]));

    const agentEnd = await reader.nextJson((event) => event.type === "agent_end");
    expect(agentEnd).toMatchObject({ type: "agent_end" });
    controller.abort();
    await registry.disposeAll();
  });
});

class StreamingTestAdapter implements PiAdapter {
  private session: StreamingTestSessionHandle | undefined;

  constructor(private readonly sessionRoot: string, private readonly promptGate: Promise<void>) {}

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    await fs.mkdir(this.sessionRoot, { recursive: true });
    this.session = new StreamingTestSessionHandle({
      id: "streaming-test-session",
      cwd: path.resolve(options.cwd),
      sessionFile: path.join(this.sessionRoot, "streaming-test-session.jsonl"),
      promptGate: this.promptGate,
    });
    return this.session;
  }

  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> {
    if (!this.session) throw new Error("No session");
    return this.session;
  }

  async listSessions(): Promise<readonly SessionListItem[]> {
    if (!this.session) return [];
    return [{ id: this.session.id, cwd: this.session.cwd, sessionFile: this.session.sessionFile, lastActivity: Date.now() }];
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "stream", name: "Stream", available: true }];
  }
}

class StreamingTestSessionHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  private readonly emitter = new EventEmitter();
  private readonly promptGate: Promise<void>;
  private messages: SessionMessage[] = [];
  private status: SessionState["status"] = "idle";

  constructor(options: { readonly id: string; readonly cwd: string; readonly sessionFile: string; readonly promptGate: Promise<void> }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sessionFile = options.sessionFile;
    this.promptGate = options.promptGate;
  }

  async getState(): Promise<SessionState> {
    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      status: this.status,
      messageCount: this.messages.length,
      totalTokens: 0,
      lastActivity: Date.now(),
    };
  }

  async getMessages(): Promise<readonly SessionMessage[]> {
    return [...this.messages];
  }

  async prompt(message: string, _attachments?: readonly PromptAttachment[]): Promise<void> {
    this.status = "running";
    this.emit({ type: "agent_start" });
    this.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "streamed before prompt resolved" },
    });
    await this.promptGate;
    const now = Date.now();
    this.messages = [
      { role: "user", content: message, timestamp: now },
      { role: "assistant", content: "done", timestamp: now + 1 },
    ];
    this.status = "idle";
    this.emit({ type: "agent_end", messages: this.messages });
  }

  async abort(): Promise<void> {
    this.status = "idle";
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
    this.emitter.emit("event", event);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

function createSseReader(response: Response) {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queued: unknown[] = [];

  async function readOne(): Promise<unknown> {
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = raw.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (!data) continue;
        return JSON.parse(data);
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream ended before expected event");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return {
    async nextJson(predicate: (event: any) => boolean = () => true): Promise<any> {
      const queuedIndex = queued.findIndex((event) => predicate(event));
      if (queuedIndex !== -1) return queued.splice(queuedIndex, 1)[0];
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const event = await readOne();
        if (predicate(event)) return event;
        queued.push(event);
      }
      throw new Error("Timed out waiting for matching SSE event");
    },
  };
}
