import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import type { CreateSessionOptions, ModelInfo, OpenSessionOptions, PiAdapter, PiSessionHandle, SessionState } from "../../src/server/pi/types.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("HTTP subagent session creation", () => {
  it("does not pre-create Pi's lazy JSONL before the child prompt, then persists hidden metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-subagent-e2e-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(sessionRoot, { recursive: true });

    const adapter = new ExclusiveCreateAdapter(sessionRoot);
    const registry = new SessionRegistry({
      adapter,
      pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    });
    const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
    servers.push(server);
    const baseUrl = await listen(server);

    const created = await fetchJson<{ id: string }>(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot, sessionName: "child", subagent: true, hiddenFromList: true }),
    });
    const sessionFile = adapter.sessionFile(created.id);
    await expect(fs.access(sessionFile)).rejects.toThrow();

    const prompted = await fetchJson<Array<{ role: string; text?: string }>>(`${baseUrl}/api/sessions/${created.id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "do child work" }),
    });
    expect(prompted).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "child completed" })]));

    const entries = (await fs.readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toEqual([
      { type: "session", id: created.id, cwd: projectRoot },
      expect.objectContaining({ type: "session_info", name: "child", subagent: true, hiddenFromList: true }),
    ]);
  });
});

class ExclusiveCreateAdapter implements PiAdapter {
  private next = 0;
  private readonly handles = new Map<string, ExclusiveCreateHandle>();

  constructor(private readonly sessionRoot: string) {}

  sessionFile(id: string): string {
    return path.join(this.sessionRoot, `${id}.jsonl`);
  }

  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    const id = `child-${++this.next}`;
    const handle = new ExclusiveCreateHandle(id, path.resolve(options.cwd), this.sessionFile(id));
    this.handles.set(id, handle);
    return handle;
  }

  async openSession(options: OpenSessionOptions): Promise<PiSessionHandle> {
    const handle = [...this.handles.values()].find((candidate) => candidate.sessionFile === options.sessionFile);
    if (!handle) throw new Error("not found");
    return handle;
  }

  async listSessions() { return []; }
  async listModels(): Promise<readonly ModelInfo[]> { return []; }
}

class ExclusiveCreateHandle implements PiSessionHandle {
  constructor(readonly id: string, readonly cwd: string, readonly sessionFile: string) {}

  async prompt(): Promise<void> {
    // This is Pi SessionManager's important invariant: new session files are
    // created exclusively by Pi at first prompt, not by the HTTP layer.
    await fs.writeFile(this.sessionFile, `${JSON.stringify({ type: "session", id: this.id, cwd: this.cwd })}\n`, { flag: "wx" });
  }

  async getState(): Promise<SessionState> {
    return { id: this.id, cwd: this.cwd, sessionFile: this.sessionFile, status: "idle", messageCount: 0, lastActivity: Date.now() };
  }

  async getMessages() {
    return [{ role: "assistant" as const, content: "child completed", timestamp: Date.now() }];
  }

  async abort() {}
  async setSessionName(): Promise<SessionState> { return this.getState(); }
  async setModel(): Promise<SessionState> { return this.getState(); }
  subscribe() { return () => {}; }
  async dispose() {}
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
