import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
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

describe("HTTP auth routes", () => {
  it("lists model providers with non-secret auth status", async () => {
    const { baseUrl } = await makeServer();

    const response = await fetchJson<{ providers: Array<{ provider: string; configured: boolean; source?: string; key?: string }> }>(`${baseUrl}/api/auth/providers`);

    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "mock", configured: false }),
    ]));
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  it("stores an API key credential and then logs it out", async () => {
    const { baseUrl, authStorage } = await makeServer();

    const login = await fetchJson<{ provider: { provider: string; configured: boolean; source?: string } }>(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", apiKey: "sk-test-secret" }),
    });

    expect(login.provider).toMatchObject({ provider: "mock", configured: true, source: "stored" });
    expect(authStorage.get("mock")).toEqual({ type: "api_key", key: "sk-test-secret" });

    const listed = await fetchJson<{ providers: Array<{ provider: string; configured: boolean; source?: string }> }>(`${baseUrl}/api/auth/providers`);
    expect(listed.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "mock", configured: true, source: "stored" }),
    ]));

    const logout = await fetchJson<{ provider: { provider: string; configured: boolean } }>(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock" }),
    });

    expect(logout.provider).toMatchObject({ provider: "mock", configured: false });
    expect(authStorage.get("mock")).toBeUndefined();
  });

  it("rejects malformed login/logout bodies with structured JSON errors", async () => {
    const { baseUrl } = await makeServer();

    await expect(fetchError(`${baseUrl}/api/auth/login`, { provider: "mock" })).resolves.toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/apiKey/) },
    });
    await expect(fetchError(`${baseUrl}/api/auth/logout`, {})).resolves.toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/provider/) },
    });
  });
});

async function makeServer(): Promise<{ readonly baseUrl: string; readonly authStorage: AuthStorage }> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-auth-route-"));
  tempRoots.push(tmpRoot);
  const projectRoot = path.join(tmpRoot, "project");
  const sessionRoot = path.join(tmpRoot, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const authStorage = AuthStorage.inMemory();
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot, authStorage });
  servers.push(server);
  return { baseUrl: await listen(server), authStorage };
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/application\/json/);
  return response.json() as Promise<T>;
}

async function fetchError(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.headers.get("content-type")).toMatch(/application\/json/);
  return { status: response.status, body: await response.json() };
}
