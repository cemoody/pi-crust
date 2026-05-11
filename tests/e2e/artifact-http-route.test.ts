/**
 * HTTP route tests for the per-session artifact store endpoint.
 *
 * The route is `GET /api/sessions/:sessionId/artifacts/:filename` and resolves
 * to `<session.cwd>/.pi/artifacts/<sessionId>/<filename>` with strict path
 * containment.
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
  PiEventListener,
  PiSessionHandle,
  SessionListItem,
  SessionMessage,
  SessionState,
  Unsubscribe,
} from "../../src/server/pi/types.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    ),
  );
});

describe("artifact HTTP route", () => {
  it("serves a stored artifact with correct MIME and cache headers", async () => {
    const ctx = await setupServer();
    try {
      const artifactsDir = path.join(ctx.projectRoot, ".pi", "artifacts", ctx.sessionId);
      await fs.mkdir(artifactsDir, { recursive: true });
      const fileName = "deadbeef.png";
      const filePath = path.join(artifactsDir, fileName);
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const response = await fetch(`${ctx.baseUrl}/api/sessions/${encodeURIComponent(ctx.sessionId)}/artifacts/${fileName}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toMatch(/private/);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns 404 for unknown sessions", async () => {
    const ctx = await setupServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/sessions/missing/artifacts/whatever.png`);
      expect(response.status).toBe(404);
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns 404 when the file does not exist on disk", async () => {
    const ctx = await setupServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/sessions/${encodeURIComponent(ctx.sessionId)}/artifacts/nope.png`);
      expect(response.status).toBe(404);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects path traversal attempts in the URL", async () => {
    const ctx = await setupServer();
    try {
      // The URL regex disallows '/' in the filename segment, so this 404s at the route layer.
      const response = await fetch(
        `${ctx.baseUrl}/api/sessions/${encodeURIComponent(ctx.sessionId)}/artifacts/${encodeURIComponent("../../../etc/passwd")}`,
      );
      // The route should refuse to serve. We accept 403 (path escape) or 404 (no such file).
      expect([403, 404]).toContain(response.status);
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns CSP sandbox header for text/html artifacts", async () => {
    const ctx = await setupServer();
    try {
      const artifactsDir = path.join(ctx.projectRoot, ".pi", "artifacts", ctx.sessionId);
      await fs.mkdir(artifactsDir, { recursive: true });
      await fs.writeFile(path.join(artifactsDir, "page.html"), "<p>hi</p>");

      const response = await fetch(`${ctx.baseUrl}/api/sessions/${encodeURIComponent(ctx.sessionId)}/artifacts/page.html`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html");
      const csp = response.headers.get("content-security-policy");
      expect(csp).toMatch(/sandbox/);
    } finally {
      await ctx.cleanup();
    }
  });
});

interface TestContext {
  readonly baseUrl: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  cleanup(): Promise<void>;
}

async function setupServer(): Promise<TestContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-http-test-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });

  const adapter = new InMemoryAdapter(projectRoot, sessionRoot);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const created = await registry.createSession({ cwd: projectRoot });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  const baseUrl = await listen(server);
  return {
    baseUrl,
    projectRoot,
    sessionRoot,
    sessionId: created.id,
    cleanup: async () => {
      await registry.disposeAll();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

class InMemoryAdapter implements PiAdapter {
  private session: InMemorySessionHandle | undefined;

  constructor(private readonly projectRoot: string, private readonly sessionRoot: string) {}

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    this.session = new InMemorySessionHandle({
      id: "test-session-id",
      cwd: path.resolve(options.cwd),
      sessionFile: path.join(this.sessionRoot, "test-session-id.jsonl"),
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
    return [{ provider: "test", id: "test", name: "Test", available: true }];
  }
}

class InMemorySessionHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  private readonly emitter = new EventEmitter();

  constructor(options: { id: string; cwd: string; sessionFile: string }) {
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

  async getMessages(): Promise<readonly SessionMessage[]> {
    return [];
  }

  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(): Promise<SessionState> { return this.getState(); }
  async setModel(): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
  async dispose(): Promise<void> { this.emitter.removeAllListeners(); }
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}`;
}
