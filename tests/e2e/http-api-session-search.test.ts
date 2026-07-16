import fsp from "node:fs/promises";
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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("HTTP session search", () => {
  it("uses the service default result limit when the limit query parameter is absent", async () => {
    const { baseUrl, projectRoot, sessionRoot } = await makeServer();
    for (let index = 0; index < 2; index++) {
      await fsp.writeFile(path.join(sessionRoot, `search-${index}.jsonl`), [
        JSON.stringify({ type: "session", version: 3, id: `search-${index}`, cwd: projectRoot, timestamp: 1_700_000_000_000 + index }),
        JSON.stringify({ type: "message", id: `u${index}`, timestamp: 1_700_000_000_100 + index, message: { role: "user", content: `eagle result ${index}`, timestamp: 1_700_000_000_100 + index } }),
      ].join("\n") + "\n");
    }

    const response = await fetch(`${baseUrl}/api/sessions/search?q=eagle`);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(2);
  });
});

async function makeServer(): Promise<{ readonly baseUrl: string; readonly projectRoot: string; readonly sessionRoot: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-search-api-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({ adapter, pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }) });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  return { baseUrl: await listen(server), projectRoot, sessionRoot };
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("server did not bind"));
    resolve(`http://127.0.0.1:${address.port}`);
  }));
}
