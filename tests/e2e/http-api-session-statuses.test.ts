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
  SessionStatus,
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

describe("HTTP API session status snapshots", () => {
  it("reports hot running sessions without opening them through /state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-remote-status-test-"));
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    await fs.mkdir(projectRoot, { recursive: true });
    const adapter = new StatusTestAdapter(sessionRoot);
    const registry = new SessionRegistry({
      adapter,
      pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    });
    const created = await registry.createSession({ cwd: projectRoot, sessionName: "running elsewhere" });
    adapter.session!.lastActivity = 123;
    adapter.session!.stateLastActivity = 999;
    adapter.session!.setStatus("running");
    const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(projectRoot)}`);

    expect(response.ok).toBe(true);
    const sessions = await response.json() as Array<{ id: string; status: string; sessionName?: string; lastActivity: number }>;
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, sessionName: "running elsewhere", status: "streaming", lastActivity: 123 }),
    ]));
  });
});

class StatusTestAdapter implements PiAdapter {
  session: StatusTestSessionHandle | undefined;

  constructor(private readonly sessionRoot: string) {}

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    await fs.mkdir(this.sessionRoot, { recursive: true });
    this.session = new StatusTestSessionHandle({
      id: "status-test-session",
      cwd: path.resolve(options.cwd),
      sessionFile: path.join(this.sessionRoot, "status-test-session.jsonl"),
      ...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
    });
    return this.session;
  }

  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> {
    if (!this.session) throw new Error("No session");
    return this.session;
  }

  async listSessions(): Promise<readonly SessionListItem[]> {
    if (!this.session) return [];
    return [{
      id: this.session.id,
      cwd: this.session.cwd,
      sessionFile: this.session.sessionFile,
      ...(this.session.sessionName === undefined ? {} : { sessionName: this.session.sessionName }),
      lastActivity: this.session.lastActivity,
    }];
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "status", name: "Status", available: true }];
  }
}

class StatusTestSessionHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  sessionName: string | undefined;
  lastActivity = Date.now();
  stateLastActivity: number | undefined;
  private status: SessionStatus = "idle";
  private readonly emitter = new EventEmitter();

  constructor(options: { readonly id: string; readonly cwd: string; readonly sessionFile: string; readonly sessionName?: string }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sessionFile = options.sessionFile;
    this.sessionName = options.sessionName;
  }

  setStatus(status: SessionStatus): void {
    this.status = status;
    if (this.stateLastActivity === undefined) this.lastActivity = Date.now();
  }

  async getState(): Promise<SessionState> {
    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      status: this.status,
      ...(this.sessionName === undefined ? {} : { sessionName: this.sessionName }),
      messageCount: 0,
      lastActivity: this.stateLastActivity ?? this.lastActivity,
    };
  }

  async getMessages(): Promise<readonly SessionMessage[]> { return []; }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> { this.setStatus("running"); }
  async abort(): Promise<void> { this.setStatus("idle"); }
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
