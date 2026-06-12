/**
 * Regression for the long-session "can't scroll back to the start" bug.
 *
 * Root cause: readSessionMessagesTail() reads the trailing window of a
 * jsonl session by collecting up to `limit` RAW jsonl `message` records,
 * then runs them through toSessionMessages(). That fan-out MERGES every
 * `role:"toolResult"` record into its matching tool row, so a window of
 * `limit` raw records normalizes to FEWER than `limit` messages.
 *
 * The web client (SessionDashboard) decides whether older history exists
 * by comparing the number of returned messages to the limit it asked for
 * (`messages.length >= INITIAL_MESSAGES_LIMIT`). Because the tail window
 * shrinks below the limit whenever it contains tool results, the client
 * concludes "this is the whole transcript", disables scroll-up
 * pagination, and the user can never reach the first message — exactly
 * what was observed on session 019ea8e9 (a 340-message tool-heavy
 * session that only ever rendered its last ~191 messages).
 *
 * The contract this test pins: GET /messages?limit=N must return N
 * messages whenever at least N messages exist in the transcript, so the
 * client's "did I get a full page?" heuristic stays reliable regardless
 * of how many tool-result records the tail window happens to contain.
 *
 * Seeds a file-backed jsonl session in the real on-disk pirpc shape
 * (assistant turns with inline `toolCall` blocks + separate
 * `role:"toolResult"` records) and drives /messages directly.
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
    server.close((error) => (error ? reject(error) : resolve()));
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

interface DashboardMessage {
  readonly id: string;
  readonly role: string;
  readonly text: unknown;
  readonly timestamp?: number;
}

// Pad records so the on-disk file spans several 64KB tail-read chunks.
// This matters: readSessionMessagesTail() reads the file backwards one
// 64KB chunk at a time and stops once it has collected `limit` RAW
// records. On a small (single-chunk) file the whole transcript is
// slurped in one read and the bug is masked, exactly like the real
// 1.2MB session only misbehaved because it was many chunks long. ~280
// bytes/record keeps each chunk to ~20 raw records, so the loop stops
// right around the 200-record boundary (mirroring the real 1.2MB
// session) instead of overshooting and slurping the whole file.
const PAD = "x".repeat(3000);

/**
 * Build a deterministic jsonl transcript with `turns` exchanges. Each
 * assistant turn is a *tool-call-only* turn (no text block) followed by a
 * separate `role:"toolResult"` record. toSessionMessages() drops the
 * empty assistant turn and merges the toolResult into the tool row, so a
 * window of N raw records normalizes to ~2/3·N messages — the shrink
 * that makes a `limit`-bounded fetch return fewer than `limit` messages.
 *
 * The first user message carries FIRST-MESSAGE-MARKER; the last tool
 * exchange carries LAST-MESSAGE-MARKER.
 */
function seedToolHeavyTranscript(turns: number): { lines: unknown[]; firstText: string; totalRawMessages: number } {
  const firstText = `FIRST-MESSAGE-MARKER: original prompt ${PAD}`;
  let ts = 1_700_000_000_000;
  const lines: unknown[] = [
    { type: "session", id: "tool-heavy-session", cwd: "/tmp/project", timestamp: new Date(ts).toISOString() },
  ];
  let rawMessages = 0;
  for (let i = 0; i < turns; i++) {
    ts += 1000;
    lines.push({
      type: "message",
      id: `u-${i}`,
      timestamp: new Date(ts).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: i === 0 ? firstText : `user turn ${i} ${PAD}` }],
      },
    });
    rawMessages++;
    ts += 1000;
    const toolCallId = `toolu_turn_${i}`;
    lines.push({
      type: "message",
      id: `a-${i}`,
      timestamp: new Date(ts).toISOString(),
      message: {
        // Tool-call-only assistant turn: no text block, so the fan-out
        // produces just a `role:"tool"` row (no assistant message).
        role: "assistant",
        content: [
          { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `echo turn ${i} ${PAD}` } },
        ],
      },
    });
    rawMessages++;
    ts += 100;
    lines.push({
      type: "message",
      id: `tr-${i}`,
      timestamp: new Date(ts).toISOString(),
      message: {
        role: "toolResult",
        toolCallId,
        content: [{ type: "text", text: i === turns - 1 ? `LAST-MESSAGE-MARKER turn ${i} output ${PAD}` : `turn ${i} output ${PAD}` }],
      },
    });
    rawMessages++;
  }
  return { lines, firstText, totalRawMessages: rawMessages };
}

describe("/messages tail-read pagination with tool-result fan-out", () => {
  it("returns a full page of `limit` messages when more older messages exist", async () => {
    // 120 turns -> 360 raw records (user + assistant + toolResult each).
    // After fan-out the toolResults merge into tool rows, so the
    // normalized transcript is well over 200 messages but a 200-raw
    // window normalizes to fewer than 200.
    const { lines } = seedToolHeavyTranscript(120);
    const { baseUrl, sessionId } = await startSeededServer(lines);

    const limit = 200;
    const page = await getMessages(baseUrl, sessionId, { limit });

    // Headline assertion: a window-limited fetch must return a *full*
    // page when the transcript is longer than the limit, otherwise the
    // client's "messages.length >= limit => more exist" heuristic breaks
    // and scroll-up pagination is silently disabled.
    expect(page.length).toBe(limit);
  });

  it("lets a `before` cursor walk all the way back to the first message", async () => {
    const { lines, firstText } = seedToolHeavyTranscript(120);
    const { baseUrl, sessionId } = await startSeededServer(lines);

    const limit = 200;
    const seen = new Map<string, DashboardMessage>();
    let page = await getMessages(baseUrl, sessionId, { limit });
    for (const m of page) seen.set(m.id, m);

    // Emulate the client's scroll-up loop: keep paging on the oldest
    // loaded timestamp until a page comes back smaller than the limit
    // (the genuine "reached the start" signal).
    for (let guard = 0; guard < 50 && page.length >= limit; guard++) {
      let oldest: number | undefined;
      for (const m of page) {
        if (typeof m.timestamp === "number" && (oldest === undefined || m.timestamp < oldest)) oldest = m.timestamp;
      }
      if (oldest === undefined) break;
      page = await getMessages(baseUrl, sessionId, { limit, before: oldest });
      for (const m of page) seen.set(m.id, m);
    }

    const texts = [...seen.values()].map((m) => (typeof m.text === "string" ? m.text : ""));
    expect(texts.some((t) => t.includes("FIRST-MESSAGE-MARKER"))).toBe(true);
    expect(firstText).toContain("FIRST-MESSAGE-MARKER");
  });
});

async function getMessages(
  baseUrl: string,
  sessionId: string,
  options: { readonly limit: number; readonly before?: number },
): Promise<DashboardMessage[]> {
  const query = new URLSearchParams({ limit: String(options.limit) });
  if (options.before !== undefined) query.set("before", String(options.before));
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages?${query.toString()}`);
  if (!response.ok) throw new Error(`/messages failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as DashboardMessage[];
}

async function startSeededServer(rawLines: readonly unknown[]): Promise<{ baseUrl: string; sessionId: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-tail-pagination-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, "tool-heavy.jsonl");
  await fsp.writeFile(sessionFile, rawLines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  const adapter = new FileBackedAdapter(sessionFile, projectRoot);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  await registry.createSession({ cwd: projectRoot, sessionName: "tool-heavy" });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  const baseUrl = await listen(server);
  return { baseUrl, sessionId: adapter.handle.id };
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
    this.handle = new FileBackedHandle({ id: "tool-heavy-session", cwd: projectRoot, sessionFile });
  }
  async createSession(_options: CreateSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async listSessions(): Promise<readonly SessionListItem[]> {
    return [{ id: this.handle.id, cwd: this.handle.cwd, sessionFile: this.handle.sessionFile, lastActivity: 0 }];
  }
  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "tool-heavy", name: "Tool heavy", available: true }];
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
    throw new Error("getMessages() should not be called: /messages?limit=N must be served from the jsonl tail-read");
  }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}
