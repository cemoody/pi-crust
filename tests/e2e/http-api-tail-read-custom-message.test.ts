/**
 * Regression test for the tail-read fast path silently dropping
 * `type: "custom_message"` jsonl records.
 *
 * Production symptom (reported via Pi Remote Control session
 * 019e5866-...): on first render the `display(...)` tool call's image
 * artifact renders correctly, but after a page reload the same session
 * shows only the raw `display` tool card with no inline image. Diagnosis:
 * the `/messages` API returns the `display` tool call but the matching
 * artifact custom-message is missing from the response.
 *
 * Root cause: readSessionMessagesTail() in http-api-server.ts filters
 * jsonl entries with `entry.type !== "message"`, so the
 * `type: "custom_message"` artifact line (which carries the
 * customType/details that ArtifactView needs) is silently discarded.
 * The adapter's own getMessages() path -- toSessionMessages() in
 * pirpc-pi-adapter -- DOES handle the customType branch (the
 * `role === "custom" || customType.length > 0` check), so the issue
 * only manifests after the tail-read fast path kicks in (i.e. after a
 * fresh page load against a file-backed session).
 *
 * This test seeds a jsonl with one `type: "custom_message"` artifact
 * record sandwiched between regular `type: "message"` records and
 * asserts the artifact survives the /messages?limit=N round trip with
 * its customType + details intact.
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
    readonly status: string;
  };
  readonly customType?: string;
  readonly details?: Record<string, unknown>;
  readonly timestamp?: number;
}

describe("/messages tail-read preserves customType artifact records", () => {
  it("round-trips a type:'custom_message' artifact line through /messages?limit=N", async () => {
    // This is the on-disk shape the @cemoody/pi-artifact `display(...)`
    // tool writes: a flat `type: "custom_message"` entry whose fields
    // (customType, content, details, timestamp) live on the OUTER record,
    // not nested under entry.message.
    const lines = [
      { type: "session", id: "tail-custom-msg-session", cwd: "/tmp/project", timestamp: "2026-05-24T15:21:50.000Z" },
      {
        type: "message",
        id: "u-1",
        timestamp: "2026-05-24T15:21:51.000Z",
        message: { role: "user", content: [{ type: "text", text: "show the test image" }] },
      },
      {
        type: "message",
        id: "a-1",
        timestamp: "2026-05-24T15:21:52.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Sure." },
            {
              type: "toolCall",
              id: "toolu_display_1",
              name: "display",
              arguments: { path: "/tmp/test.png" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "tr-1",
        timestamp: "2026-05-24T15:21:53.000Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_display_1",
          content: [{ type: "text", text: "Displayed image/png (2.0 KB)." }],
        },
      },
      // THE artifact custom_message line — flat, not wrapped under .message.
      {
        type: "custom_message",
        customType: "artifact",
        content: "Test image (test.png, 2.0 KB)",
        display: true,
        details: {
          version: 1,
          artifactGroupId: "deadbeefcafebabe",
          artifacts: [
            {
              mime: "image/png",
              src: { kind: "url", url: "/api/sessions/tail-custom-msg-session/artifacts/deadbeefcafebabe.png" },
              alt: "Test image",
              bytes: 2048,
            },
            { mime: "text/plain", text: "Test image (test.png, 2.0 KB)" },
          ],
          caption: "Test image",
        },
        id: "artifact-msg-1",
        parentId: "tr-1",
        timestamp: "2026-05-24T15:21:54.000Z",
      },
      {
        type: "message",
        id: "a-2",
        timestamp: "2026-05-24T15:21:55.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ];

    const dashboard = await loadDashboard(lines, { limit: 50 });

    // The display tool call must still be present (sanity: regression
    // baseline -- pre-fix this is the only thing the user sees after
    // a reload).
    const toolEntry = dashboard.find((m) => m.role === "tool" && m.tool?.name === "display");
    expect(toolEntry, "display tool call should survive the tail read").toBeDefined();

    // The artifact custom-message must round-trip with its customType
    // and details intact, so MessageTimeline's extractArtifactTimeline
    // can rebuild the artifact card on reload.
    const artifactEntry = dashboard.find((m) => m.customType === "artifact");
    expect(artifactEntry, "type:'custom_message' artifact line must not be dropped by readSessionMessagesTail").toBeDefined();
    expect(artifactEntry?.role).toBe("custom");
    expect(artifactEntry?.details).toBeDefined();
    expect(artifactEntry?.details?.artifactGroupId).toBe("deadbeefcafebabe");
    const reps = artifactEntry?.details?.artifacts as readonly Record<string, unknown>[] | undefined;
    expect(Array.isArray(reps)).toBe(true);
    expect(reps?.[0]?.mime).toBe("image/png");
    const src = reps?.[0]?.src as Record<string, unknown> | undefined;
    expect(src?.kind).toBe("url");
    expect(src?.url).toBe("/api/sessions/tail-custom-msg-session/artifacts/deadbeefcafebabe.png");
    expect(artifactEntry?.details?.caption).toBe("Test image");

    // Numeric timestamps are stamped on the outer record by the
    // tail-reader so the pi-crust's ordering / before-cursor logic sees
    // a consistent shape; assert that holds for custom_message records too.
    expect(typeof artifactEntry?.timestamp).toBe("number");

    // Ordering: artifact must come after the tool result and before the
    // assistant's final "Done." text, matching the on-disk order.
    const indexOf = (predicate: (m: DashboardMessage) => boolean) => dashboard.findIndex(predicate);
    const toolIndex = indexOf((m) => m.role === "tool" && m.tool?.name === "display");
    const artifactIndex = indexOf((m) => m.customType === "artifact");
    const doneIndex = indexOf((m) => m.role === "assistant" && m.text === "Done.");
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(artifactIndex).toBeGreaterThan(toolIndex);
    expect(doneIndex).toBeGreaterThan(artifactIndex);
  });
});

async function loadDashboard(rawLines: readonly unknown[], options: { readonly limit: number }): Promise<DashboardMessage[]> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-tail-custom-msg-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, "tail-custom-msg.jsonl");
  await fsp.writeFile(sessionFile, rawLines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  const adapter = new FileBackedAdapter(sessionFile, projectRoot);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  await registry.createSession({ cwd: projectRoot, sessionName: "tail-custom-msg" });
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
    this.handle = new FileBackedHandle({ id: "tail-custom-msg-session", cwd: projectRoot, sessionFile });
  }
  async createSession(_options: CreateSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async listSessions(): Promise<readonly SessionListItem[]> {
    return [{ id: this.handle.id, cwd: this.handle.cwd, sessionFile: this.handle.sessionFile, lastActivity: 0 }];
  }
  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "tail-custom-msg", name: "Tail custom msg", available: true }];
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
    // The tail-read fast path must satisfy /messages?limit=N without
    // ever calling back into the adapter -- if this fires the fast path
    // has bailed out, which would mask the regression we're guarding.
    throw new Error("FileBackedHandle.getMessages() should not be called from the tail-read fast path");
  }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}
