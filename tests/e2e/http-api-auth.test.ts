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

  it("classifies providers by login method and exposes OAuth subscription providers", async () => {
    const { baseUrl } = await makeServer();

    const response = await fetchJson<{ providers: Array<{ provider: string; oauthLogin?: boolean; apiKeyLogin?: boolean; name?: string; oauthName?: string }> }>(`${baseUrl}/api/auth/providers`);

    // The model provider logs in with an API key, not a subscription.
    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "mock", apiKeyLogin: true, oauthLogin: false }),
    ]));
    // Anthropic supports BOTH a subscription and an API key, like the TUI.
    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", oauthLogin: true, apiKeyLogin: true, oauthName: expect.any(String) }),
    ]));
  });

  it("reports the stored credential type for configured providers", async () => {
    const { baseUrl, authStorage } = await makeServer();
    authStorage.set("mock", { type: "api_key", key: "sk-test" });

    const response = await fetchJson<{ providers: Array<{ provider: string; credentialType?: string; configured?: boolean }> }>(`${baseUrl}/api/auth/providers`);
    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "mock", credentialType: "api_key", configured: true }),
    ]));
  });

  it("runs an interactive OAuth login flow over HTTP", async () => {
    const { baseUrl } = await makeServerWithFakeOAuth();

    const started = await fetchJson<OAuthSnapshot>(`${baseUrl}/api/auth/oauth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "fake-oauth" }),
    });
    expect(started.status).toBe("active");
    const flowId = started.flowId;

    // Poll until the prompt request shows up.
    let prompt: { type: string; requestId?: string; url?: string } | undefined;
    let cursor = 0;
    for (let attempt = 0; attempt < 20 && !prompt; attempt += 1) {
      const snapshot = await fetchJson<OAuthSnapshot>(`${baseUrl}/api/auth/oauth/${flowId}?cursor=${cursor}`);
      cursor = snapshot.cursor;
      expect(snapshot.events.some((event) => event.type === "auth" && event.url === "https://example.com/auth") || cursor > 0).toBe(true);
      prompt = snapshot.events.find((event) => event.type === "prompt");
      if (!prompt) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(prompt?.requestId).toBeTruthy();

    await fetchJson<OAuthSnapshot>(`${baseUrl}/api/auth/oauth/${flowId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: prompt!.requestId, value: "the-code" }),
    });

    let status = "active";
    for (let attempt = 0; attempt < 20 && status === "active"; attempt += 1) {
      const snapshot = await fetchJson<OAuthSnapshot>(`${baseUrl}/api/auth/oauth/${flowId}?cursor=${cursor}`);
      cursor = snapshot.cursor;
      status = snapshot.status;
      if (status === "active") await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toBe("done");
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

interface OAuthSnapshot {
  flowId: string;
  status: string;
  cursor: number;
  events: Array<{ type: string; requestId?: string; url?: string }>;
}

async function makeServerWithFakeOAuth(): Promise<{ readonly baseUrl: string }> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-auth-oauth-"));
  tempRoots.push(tmpRoot);
  const projectRoot = path.join(tmpRoot, "project");
  const sessionRoot = path.join(tmpRoot, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const authStorage = {
    getOAuthProviders: () => [{ id: "fake-oauth", name: "Fake OAuth", usesCallbackServer: false }],
    getAuthStatus: () => ({ configured: false }),
    get: () => undefined,
    list: () => [],
    login: async (_provider: string, callbacks: { onAuth: (info: { url: string }) => void; onPrompt: (prompt: { message: string }) => Promise<string> }) => {
      callbacks.onAuth({ url: "https://example.com/auth" });
      await callbacks.onPrompt({ message: "Paste the code" });
    },
  } as unknown as AuthStorage;
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot, authStorage });
  servers.push(server);
  return { baseUrl: await listen(server) };
}

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
