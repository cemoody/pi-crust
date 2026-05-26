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
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("HTTP API route contract matrix", () => {
  it.each([
    { method: "GET", path: "/api/no-such-endpoint", status: 404, error: /not found/i },
    { method: "POST", path: "/api/sessions", body: {}, status: 400, error: /cwd/i },
    { method: "GET", path: "/api/artifact-file", status: 400, error: /path/i },
    { method: "POST", path: "/api/settings", body: {}, status: 400, error: /settings is not configured/i },
    { method: "POST", path: "/api/settings", body: { key: "bad key", value: true }, status: 400, error: /settings is not configured/i },
    { method: "POST", path: "/api/settings/branding", body: { appName: 123 }, status: 400, error: /settings is not configured/i },
    { method: "POST", path: "/api/extensions/packages", body: {}, status: 400, error: /package installs is not configured/i },
    { method: "POST", path: "/api/extensions/packages/remove", body: {}, status: 400, error: /package removes is not configured/i },
    { method: "POST", path: "/api/extensions/nope/enabled", body: { enabled: "yes" }, status: 400, error: /extension settings is not configured/i },
    { method: "POST", path: "/api/sessions/missing/rename", body: {}, status: 400, error: /name/i },
    { method: "POST", path: "/api/sessions/missing/model", body: {}, status: 400, error: /provider.*modelId/i },
    { method: "POST", path: "/api/sessions/missing/prompt", body: {}, status: 400, error: /text|attachment/i },
    { method: "POST", path: "/api/sessions/missing/extension-ui-response", body: {}, status: 400, error: /Invalid extension UI response/i },
  ])("$method $path -> $status structured JSON error", async (contract) => {
    const { baseUrl } = await makeServer();
    const response = await fetch(`${baseUrl}${contract.path}`, {
      method: contract.method,
      ...(contract.body === undefined ? {} : { body: JSON.stringify(contract.body), headers: { "content-type": "application/json" } }),
    });
    expect(response.status).toBe(contract.status);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(contract.error) });
  });

  it.each([
    { path: "/api/health", shape: expect.objectContaining({ ok: true, adapter: "test" }) },
    { path: "/api/models", shape: expect.any(Array) },
    { path: "/api/extensions", shape: expect.objectContaining({ activities: expect.any(Array), commands: expect.any(Array), routes: expect.any(Array) }) },
    { path: "/api/client-event/stats", shape: expect.objectContaining({ total: expect.any(Number), byKind: expect.any(Object) }) },
    { path: "/api/sessions", shape: expect.any(Array) },
    { path: "/api/sessions/statuses", shape: expect.any(Array) },
  ])("GET $path returns stable JSON success shape", async ({ path, shape }) => {
    const { baseUrl } = await makeServer();
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual(shape);
  });
});

async function makeServer(): Promise<{ readonly baseUrl: string }> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-route-matrix-"));
  tempRoots.push(tmpRoot);
  const projectRoot = path.join(tmpRoot, "project");
  const sessionRoot = path.join(tmpRoot, "sessions");
  const configRoot = path.join(tmpRoot, "config");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  await fsp.mkdir(configRoot, { recursive: true });
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  return { baseUrl: await listen(server) };
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
