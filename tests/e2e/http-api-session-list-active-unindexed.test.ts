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

describe("HTTP session list", () => {
  it("keeps a live unindexed session visible when the durable index has other sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-active-unindexed-"));
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
    const liveSession = await registry.createSession({ cwd: projectRoot, sessionName: "Live work" });
    await registry.prompt(liveSession.id, "do not hide this live session");

    // This JSONL session is enough to make the durable index nonempty. The
    // mock session remains registered but is intentionally not indexable.
    await fs.writeFile(path.join(sessionRoot, "completed.jsonl"), `${JSON.stringify({
      type: "session", version: 3, id: "completed", cwd: projectRoot, timestamp: new Date().toISOString(),
    })}\n`, "utf8");

    const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
    servers.push(server);
    const baseUrl = await listen(server);

    const sessions = await fetchJson<Array<{ id: string; sessionName?: string }>>(`${baseUrl}/api/sessions`);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "completed" }),
      expect.objectContaining({ id: liveSession.id, sessionName: "Live work" }),
    ]));
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
