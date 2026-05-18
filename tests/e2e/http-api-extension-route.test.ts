import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PrcExtensionFactory } from "../../src/extensions/api.js";
import { createPrcExtensionHost } from "../../src/extensions/registry.js";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-prc-home.js";

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
      routes: expect.arrayContaining([{ method: "GET", path: "/ping", extensionId: "route-test" }]),
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

async function startExtensionServer(extensionId: string, factory: PrcExtensionFactory): Promise<string> {
  const home = await createTempPrcHome();
  homes.push(home);
  const extensions = createPrcExtensionHost();
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
