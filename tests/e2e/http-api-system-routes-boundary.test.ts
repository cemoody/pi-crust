import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
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

describe("system route subsystem boundary", () => {
  it("preserves health, models, realtime statistics, and telemetry contracts through the server dispatcher", async () => {
    const mounted = await mountServer();

    const [health, models, realtime, postEvent] = await Promise.all([
      fetchJson<Record<string, unknown>>(`${mounted.baseUrl}/api/health`),
      fetchJson<Array<{ provider: string; id: string }>>(`${mounted.baseUrl}/api/models`),
      fetchJson<{ connections: number }>(`${mounted.baseUrl}/api/realtime/stats`),
      fetch(`${mounted.baseUrl}/api/client-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "system-routes-contract" },
        body: JSON.stringify({ kind: "api-error", status: 503, path: "/api/sessions/demo/state", sessionId: "demo" }),
      }),
    ]);

    expect(health).toMatchObject({ ok: true, adapter: "test", projectRoot: mounted.projectRoot, sessionRoot: mounted.sessionRoot, terminalEnabled: false });
    expect(models).toEqual([
      { provider: "mock", id: "mock-echo", name: "Mock Echo", available: true },
      { provider: "mock", id: "mock-loud", name: "Mock Loud", available: true },
    ]);
    expect(realtime.connections).toBe(0);
    expect(postEvent.status).toBe(204);

    const stats = await fetchJson<{ total: number; byKind: Record<string, number>; byApiErrorStatus: Record<string, number>; topSessions: Array<{ sessionId: string; count: number }> }>(`${mounted.baseUrl}/api/client-event/stats?windowMs=60000`);
    expect(stats).toMatchObject({ total: 1, byKind: { "api-error": 1 }, byApiErrorStatus: { "503": 1 } });
    expect(stats.topSessions).toEqual([{ sessionId: "demo", count: 1 }]);
    expect(await fs.readFile(mounted.eventLogPath, "utf8")).toContain('"remoteAddress":"127.0.0.1"');
  });

  it("keeps telemetry validation and absent-log responses at the subsystem boundary", async () => {
    const mounted = await mountServer({ clientEventLog: false });
    const invalid = await fetch(`${mounted.baseUrl}/api/client-event`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "client-event payload must be a JSON object" });

    const stats = await fetchJson<{ total: number; byKind: Record<string, number>; topApiErrorPaths: unknown[] }>(`${mounted.baseUrl}/api/client-event/stats`);
    expect(stats).toEqual(expect.objectContaining({ total: 0, byKind: {}, topApiErrorPaths: [] }));
  });
});

async function mountServer(options: { clientEventLog?: boolean } = {}): Promise<{ baseUrl: string; projectRoot: string; sessionRoot: string; eventLogPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-system-routes-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  const eventLogPath = path.join(root, "logs", "client-events.jsonl");
  await Promise.all([fs.mkdir(projectRoot, { recursive: true }), fs.mkdir(sessionRoot, { recursive: true })]);
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({
    registry,
    adapterKind: "test",
    projectRoot,
    sessionRoot,
    defaultCwd: projectRoot,
    ...(options.clientEventLog === false ? {} : { clientEventLogPath: eventLogPath }),
  });
  servers.push(server);
  return { baseUrl: await listen(server), projectRoot, sessionRoot, eventLogPath };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
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
