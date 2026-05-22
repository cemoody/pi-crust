/**
 * Pins the on-disk-shape fan-out for the /messages tail-read fast path.
 *
 * Background: production pirpc / Anthropic-messages sessions persist a
 * jsonl stream where:
 *
 *   * assistant turns store `content` as an array of typed blocks:
 *     [{type:"text"}, {type:"thinking"}, {type:"toolCall", id, name,
 *      arguments}, ...]
 *   * tool outputs land in a *separate* record with `role: "toolResult"`
 *     and a `toolCallId` that points back at the assistant's inline
 *     toolCall block.
 *
 * The pirpc-pi-adapter's toSessionMessages() helper fans those records
 * out into the WUI's expected shape: one assistant entry (with text +
 * thinking carved out), N synthetic `role: "tool"` entries (one per
 * inline toolCall block), and each toolResult merged into the matching
 * tool entry's `output` / `status` / `completedAt`.
 *
 * PR #102 added readSessionMessagesTail() so `/messages?limit=N` can
 * read just the tail of multi-MB session files without slurping the
 * whole thing. The new path returned the raw JSONL `message` bodies
 * straight through to toDashboardMessages, skipping toSessionMessages
 * entirely. Observable symptom in production: the WUI shows tool
 * outputs as free-standing "Extension"-labelled bubbles (because
 * `role: "toolResult"` falls through toDashboardMessages's role switch
 * to `"custom"`) and inline `toolCall` blocks never produce a tool
 * row at all.
 *
 * Each test below seeds a file-backed JSONL session with the raw
 * on-disk shape, fetches /messages?limit=…, and asserts the WUI sees
 * the same fan-out it would have got from a hot adapter handle.
 */

import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

interface DashboardMessage {
  readonly id: string;
  readonly role: string;
  readonly text: unknown;
  readonly tool?: {
    readonly id: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly status: string;
    readonly output?: string;
  };
  readonly thinking?: string;
  readonly customType?: string;
}

describe("/messages tail-read fan-out", () => {
  it("merges role:'toolResult' records into the matching tool row", async () => {
    const lines = [
      { type: "session", id: "fan-out-session", cwd: "/tmp/project", timestamp: "2026-05-22T15:16:50.000Z" },
      {
        type: "message",
        id: "u-1",
        timestamp: "2026-05-22T15:16:51.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "list slides" }],
        },
      },
      {
        type: "message",
        id: "a-1",
        timestamp: "2026-05-22T15:16:52.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll search the slides directory." },
            {
              type: "toolCall",
              id: "toolu_fan_out_bash_1",
              name: "bash",
              arguments: { command: "ls /home/coder/code/pi-remote-control/extensions/slides" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "tr-1",
        timestamp: "2026-05-22T15:16:52.500Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_fan_out_bash_1",
          content: [{ type: "text", text: "package.json\nsrc\nREADME.md" }],
        },
      },
    ];

    const dashboard = await loadDashboard(lines, { limit: 10 });

    // No tool result must escape as a "custom" / "Extension" bubble.
    const customs = dashboard.filter((message) => message.role === "custom");
    expect(customs).toEqual([]);

    // The inline toolCall block produces a synthetic role:"tool" entry
    // and the toolResult merges into it.
    const toolEntry = dashboard.find((message) => message.role === "tool");
    expect(toolEntry).toBeDefined();
    expect(toolEntry?.tool?.name).toBe("bash");
    expect(toolEntry?.tool?.id).toBe("toolu_fan_out_bash_1");
    expect(toolEntry?.tool?.args).toMatchObject({ command: "ls /home/coder/code/pi-remote-control/extensions/slides" });
    expect(toolEntry?.tool?.status).toBe("success");
    expect(toolEntry?.tool?.output).toBe("package.json\nsrc\nREADME.md");

    // And the assistant entry's `text` is a flat string carrying only
    // the visible-text block, never the raw block array.
    const assistantEntry = dashboard.find((message) => message.role === "assistant");
    expect(typeof assistantEntry?.text).toBe("string");
    expect(assistantEntry?.text).toBe("I'll search the slides directory.");
  });

  it("splits assistant thinking blocks into the `thinking` field and keeps the bubble text clean", async () => {
    const lines = [
      { type: "session", id: "fan-out-thinking", cwd: "/tmp/project", timestamp: "2026-05-22T15:16:50.000Z" },
      {
        type: "message",
        id: "u-1",
        timestamp: "2026-05-22T15:16:51.000Z",
        message: { role: "user", content: [{ type: "text", text: "plan" }] },
      },
      {
        type: "message",
        id: "a-1",
        timestamp: "2026-05-22T15:16:52.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should outline the plan first." },
            { type: "text", text: "Here is the plan." },
          ],
        },
      },
    ];

    const dashboard = await loadDashboard(lines, { limit: 10 });

    const assistantEntry = dashboard.find((message) => message.role === "assistant");
    expect(assistantEntry?.text).toBe("Here is the plan.");
    expect(assistantEntry?.thinking).toBe("I should outline the plan first.");
  });

  it("emits an orphan role:'tool' entry when a toolResult has no matching toolCall", async () => {
    const lines = [
      { type: "session", id: "fan-out-orphan", cwd: "/tmp/project", timestamp: "2026-05-22T15:16:50.000Z" },
      {
        type: "message",
        id: "tr-orphan",
        timestamp: "2026-05-22T15:16:51.000Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_orphan_no_caller",
          content: [{ type: "text", text: "stranded output" }],
        },
      },
    ];

    const dashboard = await loadDashboard(lines, { limit: 10 });

    expect(dashboard.filter((message) => message.role === "custom")).toEqual([]);
    const orphan = dashboard.find((message) => message.role === "tool");
    expect(orphan?.text).toContain("stranded output");
  });
});

async function loadDashboard(rawLines: readonly unknown[], options: { readonly limit: number }): Promise<DashboardMessage[]> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-tail-fanout-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, "fan-out.jsonl");
  await fsp.writeFile(sessionFile, rawLines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  const adapter = new FileBackedAdapter(sessionFile, projectRoot);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  await registry.createSession({ cwd: projectRoot, sessionName: "fan-out" });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  const baseUrl = await listen(server);
  const sessionId = adapter.handle.id;
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages?limit=${options.limit}`);
  if (!response.ok) throw new Error(`/messages failed: ${response.status} ${await response.text()}`);
  return await response.json() as DashboardMessage[];
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected an AddressInfo from server.address()");
  return `http://127.0.0.1:${address.port}`;
}

class FileBackedAdapter implements PiAdapter {
  readonly handle: FileBackedHandle;
  constructor(sessionFile: string, projectRoot: string) {
    this.handle = new FileBackedHandle({ id: "fan-out-session", cwd: projectRoot, sessionFile });
  }
  async createSession(_options: CreateSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async listSessions(): Promise<readonly SessionListItem[]> {
    return [{ id: this.handle.id, cwd: this.handle.cwd, sessionFile: this.handle.sessionFile, lastActivity: 0 }];
  }
  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "fan-out", name: "Fan-out", available: true }];
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
    return { id: this.id, cwd: this.cwd, sessionFile: this.sessionFile, status: "idle", messageCount: 0, lastActivity: 0 };
  }
  async getMessages(): Promise<readonly SessionMessage[]> {
    // Deliberately throws if anything tries to bypass the tail-read fast
    // path. The whole point of these tests is that /messages?limit=N
    // must satisfy itself from the jsonl on disk via
    // readSessionMessagesTail() + the toSessionMessages fan-out.
    throw new Error("FileBackedHandle.getMessages() should not be called from the tail-read fast path");
  }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}
