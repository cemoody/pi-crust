import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PrcExtensionFactory } from "../../src/extensions/api.js";
import { createPrcExtensionHost } from "../../src/extensions/registry.js";
import { createPrcExtensionRuntime } from "../../src/extensions/runtime.js";
import { writeLocalExtensionPackage } from "../helpers/local-extension-package.js";
import { readPrcSettings } from "../../src/extensions/packages.js";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";

const servers: http.Server[] = [];
const homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("HTTP API extension routes", () => {
  it("serves routes contributed by an activated server extension", async () => {
    const baseUrl = await startExtensionServer("route-test", (prc) => {
      prc.commands.register({ id: "route-test.command", title: "Route Test", slashName: "route-test", run: () => "ok" });
      prc.activity.registerView({ id: "route-test.view", title: "Route Test" });
      prc.server.routes.get("/ping", () => ({ ok: true, source: prc.extensionId }));
      prc.server.routes.post("/echo/:name", async (request) => ({ body: { name: request.params.name, input: await request.json() } }));
    });

    await expect(fetchJson(`${baseUrl}/api/extensions`)).resolves.toMatchObject({
      commands: [{ id: "route-test.command", invocationName: "route-test.command", title: "Route Test", slashName: "route-test", extensionId: "route-test" }],
      activities: [{ id: "route-test.view", title: "Route Test", extensionId: "route-test" }],
      routes: expect.arrayContaining([{ method: "GET", path: "/ping", mount: "extension", extensionId: "route-test" }]),
      diagnostics: [],
    });
    await expect(fetchJson(`${baseUrl}/api/extensions/route-test/ping`)).resolves.toEqual({ ok: true, source: "route-test" });
    await expect(fetchJson(`${baseUrl}/api/extensions/route-test/echo/alice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 42 }),
    })).resolves.toEqual({ name: "alice", input: { value: 42 } });
    const missing = await fetch(`${baseUrl}/api/extensions/route-test/missing`);
    expect(missing.status).toBe(404);
  });

  it("hot reloads extensions through the HTTP API and keeps the previous host on failure", async () => {
    const home = await createTempPrcHome();
    homes.push(home);
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "reload-http-extension",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'reload.http', title: 'Reload', run: () => 'v1' }); }\n",
    });
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [packageDir] });
    const baseUrl = await startServerWithRuntime(home, runtime);

    await expect(fetchJson(`${baseUrl}/api/extensions/reload`, { method: "POST" })).resolves.toMatchObject({ applied: true });
    await fs.writeFile(path.join(packageDir, "index.mjs"), "export default function activate(prc) { prc.commands.register({ id: 'reload.http', title: 'Reload', run: () => 'v2' }); }\n", "utf8");
    await expect(fetchJson(`${baseUrl}/api/extensions/reload`, { method: "POST" })).resolves.toMatchObject({ applied: true, extensions: { commands: [expect.objectContaining({ id: "reload.http" })] } });
    await expect(fetchJson(`${baseUrl}/api/extensions/reload-http-extension/commands/reload.http`, { method: "POST", body: "{}" })).resolves.toEqual({ result: "v2" });

    await fs.writeFile(path.join(packageDir, "index.mjs"), "export const nope = true;\n", "utf8");
    const failed = await fetch(`${baseUrl}/api/extensions/reload`, { method: "POST" });
    expect(failed.status).toBe(400);
    await expect(fetchJson(`${baseUrl}/api/extensions/reload-http-extension/commands/reload.http`, { method: "POST", body: "{}" })).resolves.toEqual({ result: "v2" });
  });

  it("persists extension enable settings and reloads the runtime", async () => {
    const home = await createTempPrcHome();
    homes.push(home);
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "toggle-http-extension",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'toggle.http', title: 'Toggle', run: () => 'enabled' }); }\n",
    });
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [packageDir] });
    const baseUrl = await startServerWithRuntime(home, runtime);

    await expect(fetchJson(`${baseUrl}/api/extensions/toggle-http-extension/commands/toggle.http`, { method: "POST", body: "{}" })).resolves.toEqual({ result: "enabled" });
    await expect(fetchJson(`${baseUrl}/api/extensions/toggle-http-extension/enabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) })).resolves.toMatchObject({ applied: true, settings: { disabledExtensions: ["toggle-http-extension"] } });
    expect((await readPrcSettings(home.configDir)).disabledExtensions).toEqual(["toggle-http-extension"]);
    expect((await fetch(`${baseUrl}/api/extensions/toggle-http-extension/commands/toggle.http`, { method: "POST", body: "{}" })).status).toBe(404);
    await expect(fetchJson(`${baseUrl}/api/extensions/settings`)).resolves.toMatchObject({ disabledExtensions: ["toggle-http-extension"] });

    await expect(fetchJson(`${baseUrl}/api/extensions/toggle-http-extension/enabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) })).resolves.toMatchObject({ applied: true, settings: { disabledExtensions: [] } });
    await expect(fetchJson(`${baseUrl}/api/extensions/toggle-http-extension/commands/toggle.http`, { method: "POST", body: "{}" })).resolves.toEqual({ result: "enabled" });
  });

  it("installs and removes extension packages through the HTTP API", async () => {
    const home = await createTempPrcHome();
    homes.push(home);
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "http-installed-extension",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'installed.http', title: 'Installed', run: () => 'installed' }); }\n",
    });
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot });
    const baseUrl = await startServerWithRuntime(home, runtime);

    await expect(fetchJson(`${baseUrl}/api/extensions/packages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: packageDir }) })).resolves.toMatchObject({ applied: true });
    await expect(fetchJson(`${baseUrl}/api/extensions/http-installed-extension/commands/installed.http`, { method: "POST", body: "{}" })).resolves.toEqual({ result: "installed" });

    await expect(fetchJson(`${baseUrl}/api/extensions/packages/remove`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: packageDir }) })).resolves.toMatchObject({ applied: true });
    expect((await fetch(`${baseUrl}/api/extensions/http-installed-extension/commands/installed.http`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("changes extension web module asset URLs after reload so browser imports are cache-busted", async () => {
    const home = await createTempPrcHome();
    homes.push(home);
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "web-reload-extension",
      extensionCode: "export default function activate(prc) { prc.activity.registerView({ id: 'web.reload', title: 'Web Reload' }); }\n",
      manifest: { name: "web-reload-extension", version: "0.0.0-test", piRemoteControl: { extension: "./index.mjs", web: "./web.mjs" } },
    });
    await fs.writeFile(path.join(packageDir, "web.mjs"), "export function renderActivity(props) { return props.React.createElement('div', null, 'v1'); }\n", "utf8");
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [packageDir] });
    const baseUrl = await startServerWithRuntime(home, runtime);

    const before = await fetchJson(`${baseUrl}/api/extensions`) as { activities: Array<{ webModuleUrl?: string }> };
    await fs.writeFile(path.join(packageDir, "web.mjs"), "export function renderActivity(props) { return props.React.createElement('div', null, 'v2'); }\n", "utf8");
    await expect(fetchJson(`${baseUrl}/api/extensions/reload`, { method: "POST" })).resolves.toMatchObject({ applied: true });
    const after = await fetchJson(`${baseUrl}/api/extensions`) as { activities: Array<{ webModuleUrl?: string }> };

    expect(before.activities[0]?.webModuleUrl).toContain("/api/extensions/web-reload-extension/assets/web.mjs?v=");
    expect(after.activities[0]?.webModuleUrl).toContain("/api/extensions/web-reload-extension/assets/web.mjs?v=");
    expect(after.activities[0]?.webModuleUrl).not.toBe(before.activities[0]?.webModuleUrl);
  });

  it("rolls back persisted extension settings when reload after a settings change fails", async () => {
    const home = await createTempPrcHome();
    homes.push(home);
    const goodPackage = await writeLocalExtensionPackage(home.root, {
      name: "rollback-good-extension",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'rollback.good', title: 'Good', run: () => 'good' }); }\n",
    });
    const badPackage = await writeLocalExtensionPackage(home.root, {
      name: "rollback-bad-extension",
      extensionCode: "export const nope = true;\n",
    });
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [goodPackage] });
    const baseUrl = await startServerWithRuntime(home, runtime);

    const response = await fetch(`${baseUrl}/api/extensions/packages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: badPackage }) });

    expect(response.status).toBe(400);
    expect(await readPrcSettings(home.configDir)).toEqual({});
    await expect(fetchJson(`${baseUrl}/api/extensions/rollback-good-extension/commands/rollback.good`, { method: "POST", body: "{}" })).resolves.toEqual({ result: "good" });
  });

  it("serves extension web module assets and exposes them in metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-web-asset-"));
    homes.push({ root, configDir: root, dataDir: root, projectRoot: root, sessionRoot: root, env: process.env, cleanup: async () => fs.rm(root, { recursive: true, force: true }) });
    const assetPath = path.join(root, "web.mjs");
    await fs.writeFile(assetPath, "export const value = 'web';\n", "utf8");
    const baseUrl = await startExtensionServer("asset-test", (prc) => {
      prc.activity.registerView({ id: "asset.panel", title: "Asset Panel" });
    }, { webAsset: assetPath });

    const extensionInfo = await fetchJson(`${baseUrl}/api/extensions`) as { activities: Array<{ id: string; webModuleUrl?: string }> };
    expect(extensionInfo.activities).toEqual([expect.objectContaining({ id: "asset.panel" })]);
    expect(extensionInfo.activities[0]?.webModuleUrl).toContain("/api/extensions/asset-test/assets/web.mjs?v=");
    const response = await fetch(`${baseUrl}/api/extensions/asset-test/assets/web.mjs`);
    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toContain("value = 'web'");
  });

  it("serves built-in API compatibility routes contributed by extensions", async () => {
    const baseUrl = await startExtensionServer("core.schedule", (prc) => {
      prc.server.api.get("/api/cron-test", () => ({ ok: true, source: prc.extensionId }));
    });

    await expect(fetchJson(`${baseUrl}/api/cron-test`)).resolves.toEqual({ ok: true, source: "core.schedule" });
  });

  it("runs extension commands through the HTTP API", async () => {
    const baseUrl = await startExtensionServer("command-test", (prc) => {
      prc.commands.register({ id: "command-test.echo", title: "Echo", slashName: "echo", run: (input) => ({ input, ok: true }) });
    });

    await expect(fetchJson(`${baseUrl}/api/extensions/command-test/commands/command-test.echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ argv: "hello" }),
    })).resolves.toEqual({ result: { input: { argv: "hello" }, ok: true } });
    const missing = await fetch(`${baseUrl}/api/extensions/command-test/commands/missing`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(404);
  });

  it("isolates routes by HTTP method and decodes URL params", async () => {
    const baseUrl = await startExtensionServer("method-test", (prc) => {
      prc.server.routes.get("/thing/:name", (request) => ({ method: "GET", name: request.params.name }));
      prc.server.routes.post("/thing/:name", (request) => ({ method: "POST", name: request.params.name }));
    });

    await expect(fetchJson(`${baseUrl}/api/extensions/method-test/thing/alice%20bob`)).resolves.toEqual({ method: "GET", name: "alice bob" });
    await expect(fetchJson(`${baseUrl}/api/extensions/method-test/thing/alice%20bob`, { method: "POST" })).resolves.toEqual({ method: "POST", name: "alice bob" });
  });

  it("passes custom status codes and headers from extension routes", async () => {
    const baseUrl = await startExtensionServer("headers-test", (prc) => {
      prc.server.routes.get("/accepted", () => ({ status: 202, headers: { "X-Test-Extension": "yes" }, body: { ok: true } }));
    });

    const response = await fetch(`${baseUrl}/api/extensions/headers-test/accepted`);

    expect(response.status).toBe(202);
    expect(response.headers.get("x-test-extension")).toBe("yes");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns 500 for throwing extension route handlers and keeps the server alive", async () => {
    const baseUrl = await startExtensionServer("error-test", (prc) => {
      prc.server.routes.get("/boom", () => { throw new Error("boom"); });
      prc.server.routes.get("/ok", () => ({ ok: true }));
    });

    const failed = await fetch(`${baseUrl}/api/extensions/error-test/boom`);
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: "boom" });
    await expect(fetchJson(`${baseUrl}/api/extensions/error-test/ok`)).resolves.toEqual({ ok: true });
  });
});

async function startExtensionServer(extensionId: string, factory: PrcExtensionFactory, options: { readonly webAsset?: string } = {}): Promise<string> {
  const home = await createTempPrcHome();
  homes.push(home);
  const extensions = createPrcExtensionHost();
  if (options.webAsset) extensions.registerWebAsset(extensionId, options.webAsset);
  await extensions.activate({ id: extensionId, factory });
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot: home.sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [home.projectRoot], allowedSessionRoots: [home.sessionRoot] }),
  });
  const server = createHttpApiServer({
    registry,
    adapterKind: "test",
    projectRoot: home.projectRoot,
    sessionRoot: home.sessionRoot,
    defaultCwd: home.projectRoot,
    extensions,
  });
  servers.push(server);
  return listen(server);
}

async function startServerWithRuntime(home: TempPrcHome, runtime: Awaited<ReturnType<typeof createPrcExtensionRuntime>>): Promise<string> {
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot: home.sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [home.projectRoot], allowedSessionRoots: [home.sessionRoot] }),
  });
  const server = createHttpApiServer({
    registry,
    adapterKind: "test",
    projectRoot: home.projectRoot,
    sessionRoot: home.sessionRoot,
    defaultCwd: home.projectRoot,
    extensionRuntime: runtime,
  });
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
