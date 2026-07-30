import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { persistOversizedTranscriptBodies, transcriptSidecarDirectory } from "../../src/server/pi/transcript-sidecars.js";
import type { CreateSessionOptions, ModelInfo, OpenSessionOptions, PiAdapter, PiEventListener, PiSessionHandle, PromptAttachment, SessionListItem, SessionMessage, SessionState, Unsubscribe } from "../../src/server/pi/types.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const roots: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("oversized transcript body sidecars", () => {
  it("keeps a new giant tool/artifact JSONL row and timeline payload bounded while lazy detail restores the full body", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sidecar-repro-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    const sessionFile = path.join(sessionRoot, "giant.jsonl");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(sessionRoot, { recursive: true });

    // Repro: one real Pi-shaped toolResult contains 6 MiB of output + artifact
    // data. Before sidecars this single JSONL line and every subsequent
    // timeline read carried the complete 6 MiB payload.
    const giantOutput = `OUTPUT-BEGIN:${"o".repeat(3 * 1024 * 1024)}:OUTPUT-END`;
    const giantHtml = `HTML-BEGIN:${"h".repeat(3 * 1024 * 1024)}:HTML-END`;
    const entries = [
      { type: "session", version: 3, id: "giant-sidecar", cwd: projectRoot, timestamp: new Date(1_000).toISOString() },
      { type: "message", id: "assistant", parentId: null, timestamp: new Date(1_000).toISOString(), message: { role: "assistant", timestamp: 1_000, content: [{ type: "toolCall", id: "call-giant", name: "show_presentation", arguments: { title: "Huge deck" } }] } },
      { type: "message", id: "result", parentId: "assistant", timestamp: new Date(2_000).toISOString(), message: { role: "toolResult", timestamp: 2_000, toolCallId: "call-giant", toolName: "show_presentation", isError: false, content: [{ type: "text", text: giantOutput }], details: { piRemoteControlArtifact: { kind: "presentation", title: "Huge deck", data: { slides: [{ html: giantHtml }] } } } } },
    ];
    await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const beforeBytes = (await fs.stat(sessionFile)).size;
    const compacted = await persistOversizedTranscriptBodies(sessionFile);
    const transcript = await fs.readFile(sessionFile, "utf8");
    const rowBytes = Buffer.byteLength(transcript.trim().split("\n").at(-1)!, "utf8");
    const afterBytes = (await fs.stat(sessionFile)).size;
    const sidecarDirectory = transcriptSidecarDirectory(sessionFile);
    const sidecars = await fs.readdir(sidecarDirectory);

    expect(beforeBytes).toBeGreaterThan(6 * 1024 * 1024);
    expect(compacted.rewrittenRows).toBe(1);
    expect(sidecars).toHaveLength(2);
    // Durable transcript records stay compact enough for Pi's normal JSONL
    // loading/scanning path; bodies live in 0600 content-addressed sidecars.
    expect(rowBytes).toBeLessThan(8 * 1024);
    // 6,291,734 B → < 1 KiB: >99.98% less transcript I/O for this row.
    expect(afterBytes / beforeBytes).toBeLessThan(0.001);
    expect(transcript).not.toContain(giantOutput);
    expect(transcript).not.toContain(giantHtml);
    expect((await fs.stat(path.join(sidecarDirectory, sidecars[0]!))).mode & 0o777).toBe(0o600);

    const adapter = new JsonlAdapter("giant-sidecar", projectRoot, sessionFile);
    const registry = new SessionRegistry({
      adapter,
      pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    });
    await registry.openSession(sessionFile);
    const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
    servers.push(server);
    const baseUrl = await listen(server);

    const timeline = await fetch(`${baseUrl}/api/sessions/giant-sidecar/messages?limit=25`);
    expect(timeline.ok).toBe(true);
    const timelineBody = await timeline.text();
    // Measured regression guard: a 6 MiB physical body yields a tiny timeline
    // bootstrap response, retaining the existing lazy detail API contract.
    expect(Buffer.byteLength(timelineBody, "utf8")).toBeLessThan(80 * 1024);
    expect(timelineBody).not.toContain(giantOutput);
    expect(timelineBody).not.toContain(giantHtml);
    const message = JSON.parse(timelineBody)[0] as { tool: { outputUrl?: string; artifactUrl?: string; outputTruncated?: boolean; artifactTruncated?: boolean; artifact?: { artifactUrl?: string; artifactTruncated?: boolean } } };
    // The persisted row intentionally holds only a short text preview; its
    // full body is still exposed through the unchanged lazy tool-output API.
    expect(message.tool.artifact).toMatchObject({ artifactTruncated: true });
    expect(message.tool.outputUrl).toMatch(/\/tool-output$/);

    const [output, artifact] = await Promise.all([
      fetch(`${baseUrl}${message.tool.outputUrl}`),
      fetch(`${baseUrl}${message.tool.artifact!.artifactUrl}`),
    ]);
    expect(await output.text()).toBe(giantOutput);
    expect(JSON.stringify(await artifact.json())).toContain(giantHtml);
  });

  it("does not rewrite legacy transcript rows below the threshold", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sidecar-legacy-"));
    roots.push(root);
    const sessionFile = path.join(root, "legacy.jsonl");
    const legacy = JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "small old payload" }] } });
    await fs.writeFile(sessionFile, `${legacy}\n`, "utf8");
    expect(await persistOversizedTranscriptBodies(sessionFile)).toEqual({ rewrittenRows: 0, sidecarBytes: 0 });
    expect(await fs.readFile(sessionFile, "utf8")).toBe(`${legacy}\n`);
  });
});

class JsonlAdapter implements PiAdapter {
  readonly handle: JsonlHandle;
  constructor(id: string, cwd: string, sessionFile: string) { this.handle = new JsonlHandle(id, cwd, sessionFile); }
  async createSession(_options: CreateSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async listSessions(): Promise<readonly SessionListItem[]> { return [{ id: this.handle.id, cwd: this.handle.cwd, sessionFile: this.handle.sessionFile, lastActivity: 0 }]; }
  async listModels(): Promise<readonly ModelInfo[]> { return []; }
}

class JsonlHandle implements PiSessionHandle {
  readonly emitter = new EventEmitter();
  constructor(readonly id: string, readonly cwd: string, readonly sessionFile: string) {}
  async getState(): Promise<SessionState> { return { id: this.id, cwd: this.cwd, sessionFile: this.sessionFile, status: "idle", messageCount: 0, lastActivity: 0 }; }
  async getMessages(): Promise<readonly SessionMessage[]> { return []; }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(_name: string): Promise<SessionState> { return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("server did not bind"));
    resolve(`http://127.0.0.1:${address.port}`);
  }));
}
