import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrcExtensionRuntime } from "../../src/extensions/runtime.js";
import { readPrcSettings } from "../../src/extensions/packages.js";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("HTTP API branding", () => {
  it("exposes app name and image icon URL from environment on health", async () => {
    const previousName = process.env.PI_CRUST_APP_NAME;
    const previousIcon = process.env.PI_CRUST_APP_ICON;
    process.env.PI_CRUST_APP_NAME = "Moody Lab";
    process.env.PI_CRUST_APP_ICON = "https://example.com/icon.png";
    try {
      const baseUrl = await makeServer();
      await expect(fetchJson(`${baseUrl}/api/health`)).resolves.toMatchObject({
        appName: "Moody Lab",
        appIcon: "https://example.com/icon.png",
      });
    } finally {
      restoreEnv("PI_CRUST_APP_NAME", previousName);
      restoreEnv("PI_CRUST_APP_ICON", previousIcon);
    }
  });

  it("persists app branding from settings and reflects it on health", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-branding-settings-"));
    const configDir = path.join(root, "config");
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(sessionRoot, { recursive: true });
    const registry = new SessionRegistry({
      adapter: new MockPiAdapter({ sessionRoot }),
      pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    });
    const extensionRuntime = await createPrcExtensionRuntime({ configDir, cwd: projectRoot });
    const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot, extensionRuntime });
    servers.push(server);
    const baseUrl = await listen(server);

    await expect(fetchJson(`${baseUrl}/api/settings/branding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appName: "Mobile Lab", appIconUrl: "https://example.com/lab-logo.svg" }),
    })).resolves.toEqual({ appName: "Mobile Lab", appIcon: "https://example.com/lab-logo.svg" });

    await expect(fetchJson(`${baseUrl}/api/health`)).resolves.toMatchObject({
      appName: "Mobile Lab",
      appIcon: "https://example.com/lab-logo.svg",
    });
    await expect(fetchJson(`${baseUrl}/api/extensions/settings`)).resolves.toMatchObject({
      appBranding: { appName: "Mobile Lab", appIconUrl: "https://example.com/lab-logo.svg" },
    });
    await expect(readPrcSettings(configDir)).resolves.toMatchObject({
      appBranding: { appName: "Mobile Lab", appIconUrl: "https://example.com/lab-logo.svg" },
    });
  });

  it("rejects non-image app icon values in branding settings", async () => {
    const baseUrl = await makeServerWithSettings();
    const response = await fetch(`${baseUrl}/api/settings/branding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appName: "Bad", appIconUrl: "🚀" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("image URL") });
  });
});

async function makeServer(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-branding-api-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  return listen(server);
}

async function makeServerWithSettings(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-branding-settings-"));
  const configDir = path.join(root, "config");
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const extensionRuntime = await createPrcExtensionRuntime({ configDir, cwd: projectRoot });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot, extensionRuntime });
  servers.push(server);
  return listen(server);
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return response.json();
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
