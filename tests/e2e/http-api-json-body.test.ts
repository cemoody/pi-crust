import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer, JSON_BODY_MAX_BYTES } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function setupServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-json-body-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "mock", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  return { baseUrl: await listen(server), projectRoot };
}

describe("HTTP API JSON body handling", () => {
  it("returns 400 instead of 500 for malformed JSON request bodies", async () => {
    const { baseUrl } = await setupServer();

    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "request body was not valid JSON" });
  });

  it("returns 413 before buffering unbounded JSON request bodies", async () => {
    const { baseUrl, projectRoot } = await setupServer();
    const body = JSON.stringify({ cwd: projectRoot, sessionName: "x".repeat(JSON_BODY_MAX_BYTES) });

    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request body too large" });
  });
});

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
