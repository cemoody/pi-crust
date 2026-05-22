/**
 * Failing TDD specs for the `/api/sessions/:id/messages` response.
 *
 * Problem statement: in production a session with embedded base64 images
 * and/or large tool payloads produces a ~30 MB JSON body that takes ~50 s to
 * load on a local network. These tests pin down the desired contract:
 *
 *   1. Inline image bytes must not appear in the message-list response.
 *   2. Many image-bearing messages must not balloon the response size.
 *   3. Multi-MB tool outputs must not appear inline at full size.
 *   4. The endpoint must support pagination so large transcripts don't have
 *      to ship in one shot.
 *
 * All four tests currently FAIL against the existing toDashboardMessages()
 * implementation. They live under tests/e2e so they exercise the real
 * createHttpApiServer route, not a mocked router.
 */

import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fs = fsp;
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
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("GET /api/sessions/:id/messages payload budget", () => {
  it("does not inline raw base64 image bytes in the message list", async () => {
    const oneMegabyteOfPng = "A".repeat(1_000_000);
    const { baseUrl, sessionId } = await startWithMessages([
      {
        role: "assistant",
        content: "here is a chart",
        timestamp: 1,
        images: [{ data: oneMegabyteOfPng, mimeType: "image/png" }],
      },
    ]);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`);
    expect(response.ok).toBe(true);
    const body = await response.text();

    // The raw base64 payload must not appear inline. The endpoint is allowed
    // to substitute a reference (e.g. a URL or content hash) so the WUI can
    // lazy-load images on demand.
    expect(body).not.toContain(oneMegabyteOfPng);
    expect(body.length).toBeLessThan(200_000);
  });

  it("stays bounded when a session contains many image-bearing messages", async () => {
    // 20 messages × ~500 KB image each = ~10 MB of base64 today.
    const imageChunk = "B".repeat(500_000);
    const messages: SessionMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant" as const,
      content: `frame ${index}`,
      timestamp: index + 1,
      images: [{ data: imageChunk, mimeType: "image/png" }],
    }));
    const { baseUrl, sessionId } = await startWithMessages(messages);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`);
    expect(response.ok).toBe(true);
    const body = await response.text();

    // Sidebar/timeline should still receive structural data for all 20
    // messages, but the *total* payload must not balloon to many MB.
    expect(body.length).toBeLessThan(500_000);
    const parsed = JSON.parse(body) as Array<{ role: string }> | { messages?: Array<{ role: string }> };
    const list = Array.isArray(parsed) ? parsed : parsed.messages ?? [];
    expect(list.length).toBe(20);
  });

  it("does not inline multi-megabyte tool output at full size", async () => {
    const bigToolOutput = "C".repeat(3_000_000); // 3 MB
    const { baseUrl, sessionId } = await startWithMessages([
      {
        role: "tool",
        content: "",
        timestamp: 1,
        tool: {
          id: "tool-1",
          name: "bash",
          args: { command: "cat huge.log" },
          status: "success",
          output: bigToolOutput,
        },
      },
    ]);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`);
    expect(response.ok).toBe(true);
    const body = await response.text();

    // The 3 MB output should be truncated / linked, not inlined verbatim.
    expect(body).not.toContain(bigToolOutput);
    expect(body.length).toBeLessThan(200_000);
  });

  it("does not read the entire session jsonl when ?limit=N is requested", async () => {
    // Build a large session file on disk and use a file-backed adapter so
    // the server has to actually do I/O to materialise messages. The
    // implementation may either teach the adapter about windows OR read the
    // file tail directly in the route handler. Either way the FS bytes
    // charged to a tail-only request must be O(window), not O(file).
    const totalMessages = 1500;
    const { baseUrl, sessionId, sessionFile } = await startWithFileBackedMessages(totalMessages);

    const fileStat = await fs.stat(sessionFile);
    expect(fileStat.size).toBeGreaterThan(5_000_000); // sanity: the file is big enough that a naive full-scan is obvious.

    const bytesRead = trackBytesReadFrom(sessionFile);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages?limit=25`);
    expect(response.ok).toBe(true);
    await response.text();

    // 25 messages × a few KB each ≈ well under 200 KB. The current
    // implementation reads the whole multi-MB file via the adapter.
    expect(bytesRead.total()).toBeLessThan(200_000);
  });

  it("supports paginating very long transcripts via a limit parameter", async () => {
    const messages: SessionMessage[] = Array.from({ length: 250 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message ${index}`,
      timestamp: index + 1,
    }));
    const { baseUrl, sessionId } = await startWithMessages(messages);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages?limit=25`);
    expect(response.ok).toBe(true);
    const parsed = await response.json() as
      | Array<{ text: string; timestamp: number }>
      | { messages: Array<{ text: string; timestamp: number }>; total?: number; nextCursor?: string | null };

    const list = Array.isArray(parsed) ? parsed : parsed.messages;
    // Server must honour the requested window instead of returning all 250.
    expect(list.length).toBe(25);
    // And it should preserve recency: the tail (most recent messages) is what
    // the WUI needs first, so the last item should be message 249.
    expect(list[list.length - 1]?.timestamp).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function trackBytesReadFrom(targetFile: string): { total: () => number } {
  let totalBytes = 0;
  const resolved = path.resolve(targetFile);
  const originalReadFile = fsp.readFile.bind(fsp);
  vi.spyOn(fsp, "readFile").mockImplementation(async (filePath: Parameters<typeof fsp.readFile>[0], opts?: Parameters<typeof fsp.readFile>[1]) => {
    const result = await (originalReadFile as unknown as (p: typeof filePath, o?: typeof opts) => Promise<string | Buffer>)(filePath, opts);
    if (typeof filePath === "string" && path.resolve(filePath) === resolved) {
      totalBytes += typeof result === "string" ? Buffer.byteLength(result, "utf8") : result.byteLength;
    }
    return result as never;
  });
  const originalOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
    const handle = await (originalOpen as (...a: typeof args) => ReturnType<typeof fsp.open>)(...args);
    const filePath = args[0];
    if (typeof filePath === "string" && path.resolve(filePath) === resolved) {
      const originalRead = handle.read.bind(handle);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handle as any).read = (async (...readArgs: any[]) => {
        const result = await (originalRead as (...a: any[]) => Promise<{ bytesRead: number }>)(...readArgs);
        totalBytes += result.bytesRead ?? 0;
        return result;
      });
    }
    return handle;
  }) as typeof fsp.open);
  return { total: () => totalBytes };
}

/**
 * Builds a session whose getMessages() actually reads + parses the on-disk
 * jsonl, mirroring the production sdk-pi-adapter. Used by the bytes-read
 * budget test for ?limit so we measure I/O the same way production does.
 */
async function startWithFileBackedMessages(messageCount: number): Promise<{ baseUrl: string; sessionId: string; sessionFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-msgs-file-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, "file-backed.jsonl");

  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "session", id: "file-backed-session", cwd: projectRoot, timestamp: 1_700_000_000_000 }));
  // ~4 KB per line so a tail of 25 messages is ~100 KB (under the 200 KB
  // budget) while the full file is still comfortably multi-megabyte for
  // messageCount ~= 1500.
  const padding = "y".repeat(4_000);
  for (let index = 0; index < messageCount; index++) {
    lines.push(JSON.stringify({
      type: "message",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ${padding}`,
        timestamp: 1_700_000_000_000 + index * 1000,
      },
    }));
  }
  await fs.writeFile(sessionFile, lines.join("\n") + "\n", "utf8");

  const adapter = new FileBackedAdapter(sessionFile, projectRoot);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  await registry.createSession({ cwd: projectRoot, sessionName: "file-backed" });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  const baseUrl = await listen(server);
  return { baseUrl, sessionId: adapter.handle.id, sessionFile };
}

class FileBackedAdapter implements PiAdapter {
  readonly handle: FileBackedHandle;
  constructor(sessionFile: string, projectRoot: string) {
    this.handle = new FileBackedHandle({ id: "file-backed-session", cwd: projectRoot, sessionFile });
  }
  async createSession(_options: CreateSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async listSessions(): Promise<readonly SessionListItem[]> {
    return [{ id: this.handle.id, cwd: this.handle.cwd, sessionFile: this.handle.sessionFile, lastActivity: 0 }];
  }
  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "file-backed", name: "File-backed", available: true }];
  }
}

class FileBackedHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  sessionName: string | undefined;
  private readonly emitter = new EventEmitter();
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
      status: "idle",
      messageCount: 0,
      lastActivity: 0,
    };
  }
  async getMessages(): Promise<readonly SessionMessage[]> {
    // Mirrors the production sdk-pi-adapter: slurp the whole jsonl, parse it,
    // and yield every message. The desired implementation should NOT route
    // tail-only requests through this method.
    const content = await fsp.readFile(this.sessionFile, "utf8");
    const messages: SessionMessage[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; message?: SessionMessage };
        if (entry.type === "message" && entry.message) messages.push(entry.message);
      } catch { /* skip */ }
    }
    return messages;
  }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}

async function startWithMessages(messages: readonly SessionMessage[]): Promise<{ baseUrl: string; sessionId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-msgs-payload-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });

  const adapter = new MessagesPayloadAdapter(sessionRoot, messages);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const created = await registry.createSession({ cwd: projectRoot, sessionName: "payload" });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  const baseUrl = await listen(server);
  return { baseUrl, sessionId: created.id };
}

class MessagesPayloadAdapter implements PiAdapter {
  private handle: MessagesPayloadHandle | undefined;
  constructor(private readonly sessionRoot: string, private readonly messages: readonly SessionMessage[]) {}

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    const sessionFile = path.join(this.sessionRoot, "payload-session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    this.handle = new MessagesPayloadHandle({
      id: "payload-session",
      cwd: path.resolve(options.cwd),
      sessionFile,
      ...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
    }, this.messages);
    return this.handle;
  }

  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> {
    if (!this.handle) throw new Error("no session");
    return this.handle;
  }

  async listSessions(): Promise<readonly SessionListItem[]> {
    if (!this.handle) return [];
    return [{
      id: this.handle.id,
      cwd: this.handle.cwd,
      sessionFile: this.handle.sessionFile,
      ...(this.handle.sessionName === undefined ? {} : { sessionName: this.handle.sessionName }),
      lastActivity: 0,
    }];
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "payload", name: "Payload", available: true }];
  }
}

class MessagesPayloadHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  sessionName: string | undefined;
  private readonly emitter = new EventEmitter();
  constructor(options: { readonly id: string; readonly cwd: string; readonly sessionFile: string; readonly sessionName?: string }, private readonly messages: readonly SessionMessage[]) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sessionFile = options.sessionFile;
    this.sessionName = options.sessionName;
  }
  async getState(): Promise<SessionState> {
    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      status: "idle",
      ...(this.sessionName === undefined ? {} : { sessionName: this.sessionName }),
      messageCount: this.messages.length,
      lastActivity: 0,
    };
  }
  async getMessages(): Promise<readonly SessionMessage[]> { return this.messages; }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
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
