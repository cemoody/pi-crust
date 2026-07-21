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

describe("HTTP mock session listing with mixed fixture formats", () => {
  it("keeps mock JSON sessions visible when the session root also has an indexed JSONL fixture", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-mock-mixed-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(sessionRoot, { recursive: true });

    const adapter = new MockPiAdapter({ sessionRoot });
    const registry = new SessionRegistry({
      adapter,
      pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    });
    const mockSession = await registry.createSession({ cwd: projectRoot, sessionName: "Seeded session" });
    await registry.prompt(mockSession.id, "previously sent hello");

    // The production-tail-read fixture causes SessionSearchService to have
    // indexed rows. It must not hide the mock JSON session used by browser
    // suites running against the mock adapter.
    await fs.writeFile(path.join(sessionRoot, "fixture.jsonl"), `${JSON.stringify({
      type: "session", id: "jsonl-fixture", cwd: projectRoot, timestamp: new Date().toISOString(),
    })}\n`, "utf8");

    const server = createHttpApiServer({ registry, adapterKind: "mock", projectRoot, sessionRoot, defaultCwd: projectRoot });
    servers.push(server);
    const baseUrl = await listen(server);

    const sessions = await fetchJson<Array<{ id: string; sessionName?: string }>>(`${baseUrl}/api/sessions`);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mockSession.id, sessionName: "Seeded session" }),
      expect.objectContaining({ id: "jsonl-fixture" }),
    ]));

    const state = await fetch(`${baseUrl}/api/sessions/${mockSession.id}/state`);
    expect(state.status).toBe(200);
  });
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
