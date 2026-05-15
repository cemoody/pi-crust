/**
 * Unit-level verification of server-side SSE eviction by tabSessionId.
 *
 * Sister to tests/playwright/sse-connection-pool.spec.ts, which exercises the
 * symptom end-to-end in a real browser. This test pokes the API directly and
 * asserts the protocol contract:
 *
 *  - Opening an SSE with `?tabSessionId=X` registers it as the active stream
 *    for tab X.
 *  - Opening another SSE with the same X causes the server to send an
 *    `event: evicted` frame and close the prior stream.
 *  - The new stream stays open and works normally.
 *  - A SECOND tab id stays open in parallel (no false-positive eviction).
 *  - When a stream closes on its own, the server's active-tab table is
 *    cleaned up (we test this by opening, closing, then opening again — the
 *    second open should be the only active stream without emitting an evicted
 *    frame to a ghost).
 */
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

describe("HTTP API SSE eviction by tabSessionId", () => {
  it("evicts a prior SSE for the same tabSessionId", async () => {
    const { baseUrl, sessionId } = await setup();

    const first = await openSse(baseUrl, sessionId, "tab-A");
    await first.read(); // consume `ready`

    const second = await openSse(baseUrl, sessionId, "tab-A");
    await second.read(); // consume `ready` for second

    // The first stream should receive an `evicted` event and then close.
    const evicted = await first.readEvent();
    expect(evicted.event).toBe("evicted");
    const closed = await first.readToEnd(2_000);
    expect(closed).toBe(true);

    // The second stream stays up.
    expect(second.controller.signal.aborted).toBe(false);
    second.controller.abort();
    first.controller.abort();
  });

  it("does NOT evict streams with different tabSessionIds", async () => {
    const { baseUrl, sessionId } = await setup();

    const a = await openSse(baseUrl, sessionId, "tab-A");
    await a.read();

    const b = await openSse(baseUrl, sessionId, "tab-B");
    await b.read();

    // Neither stream should have been evicted; reading with a short timeout
    // should NOT produce a closed signal.
    const aClosed = await a.readToEnd(300);
    expect(aClosed).toBe(false);
    const bClosed = await b.readToEnd(300);
    expect(bClosed).toBe(false);

    a.controller.abort();
    b.controller.abort();
  });

  it("requests WITHOUT a tabSessionId are never evicted (back-compat)", async () => {
    const { baseUrl, sessionId } = await setup();

    const a = await openSse(baseUrl, sessionId, undefined);
    await a.read();

    const b = await openSse(baseUrl, sessionId, undefined);
    await b.read();

    const aClosed = await a.readToEnd(300);
    expect(aClosed).toBe(false);

    a.controller.abort();
    b.controller.abort();
  });

  it("frees the active-tab entry on natural close so a later open succeeds without phantom eviction", async () => {
    const { baseUrl, sessionId } = await setup();

    // Open and immediately close.
    const first = await openSse(baseUrl, sessionId, "tab-X");
    await first.read();
    first.controller.abort();
    // Give the server's req.on("close") a tick to fire and clean up the map.
    await new Promise((r) => setTimeout(r, 50));

    // Opening again with the same tab id should NOT emit an `evicted` event
    // to anyone (there's no live previous stream). We verify by reading the
    // first frame on the new stream and confirming it's `ready`, not anything
    // else; and by opening a SECOND fresh stream for tab-X-2 and observing
    // that the original tab-X stream is still alive.
    const second = await openSse(baseUrl, sessionId, "tab-X");
    const readyFrame = await second.readEvent();
    expect(readyFrame.event).toBe("ready");

    const other = await openSse(baseUrl, sessionId, "tab-X-2");
    await other.read();
    // `second` (tab-X) should not have received an evicted frame from `other`
    // (different tab id), so it stays open.
    const secondClosed = await second.readToEnd(300);
    expect(secondClosed).toBe(false);

    second.controller.abort();
    other.controller.abort();
  });
});

// ---- Test helpers (lighter-weight than the full StreamingTestAdapter used
// in http-api-sse.test.ts; we don't need to assert event ordering here, just
// the SSE control-flow frames). --------------------------------------------

async function setup(): Promise<{ baseUrl: string; sessionId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-remote-sse-evict-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  const adapter = new IdleAdapter(sessionRoot);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const created = await registry.createSession({ cwd: projectRoot });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return { baseUrl: `http://127.0.0.1:${address.port}`, sessionId: created.id };
}

interface SseHandle {
  readonly controller: AbortController;
  /** Read the next SSE event block (split on \n\n). Returns `null` if the stream ended. */
  read(): Promise<string | null>;
  /** Read the next event and parse out the `event:` and `data:` field. */
  readEvent(): Promise<{ event: string; data: string }>;
  /** Block until either EOF or the timeout. Returns true if EOF arrived. */
  readToEnd(timeoutMs: number): Promise<boolean>;
}

async function openSse(baseUrl: string, sessionId: string, tabSessionId: string | undefined): Promise<SseHandle> {
  const qs = tabSessionId ? `?tabSessionId=${encodeURIComponent(tabSessionId)}` : "";
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events${qs}`, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`SSE open failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readBlock(): Promise<string | null> {
    while (true) {
      const sep = buffer.indexOf("\n\n");
      if (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        return block;
      }
      const chunk = await reader.read();
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return {
    controller,
    read: readBlock,
    async readEvent() {
      const block = await readBlock();
      if (block === null) throw new Error("Stream ended before event");
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice("data:".length).trim() ?? "";
      return { event: eventLine, data: dataLine };
    },
    async readToEnd(timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const block = await Promise.race([
          readBlock(),
          new Promise<symbol>((resolve) => setTimeout(() => resolve(TIMEOUT), remaining)),
        ]);
        if (block === TIMEOUT) return false;
        if (block === null) return true;
        // got a non-null block; keep waiting for more
      }
      return false;
    },
  };
}

const TIMEOUT = Symbol("timeout");

class IdleAdapter implements PiAdapter {
  private readonly sessionRoot: string;
  private session?: IdleSessionHandle;

  constructor(sessionRoot: string) {
    this.sessionRoot = sessionRoot;
  }

  async createSession(_options: CreateSessionOptions): Promise<PiSessionHandle> {
    this.session = new IdleSessionHandle({
      id: "idle-test-session",
      cwd: _options.cwd,
      sessionFile: path.join(this.sessionRoot, "idle-test-session.jsonl"),
    });
    return this.session;
  }

  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> {
    if (!this.session) throw new Error("no session");
    return this.session;
  }

  async listSessions(): Promise<readonly SessionListItem[]> {
    if (!this.session) return [];
    return [{ id: this.session.id, cwd: this.session.cwd, sessionFile: this.session.sessionFile, lastActivity: Date.now() }];
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return [];
  }
}

class IdleSessionHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
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
      totalTokens: 0,
      lastActivity: Date.now(),
    };
  }
  async getMessages(): Promise<readonly SessionMessage[]> { return []; }
  async prompt(_message: string, _attachments?: readonly PromptAttachment[]): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(): Promise<SessionState> { return this.getState(); }
  async setModel(): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
  async dispose(): Promise<void> { this.emitter.removeAllListeners(); }
  emit(event: PiEvent): void { this.emitter.emit("event", event); }
}
