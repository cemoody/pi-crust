import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import type { PiSessionHandle } from "../../src/server/pi/types.js";
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

describe("HTTP dynamic Pi command routes", () => {
  it("lists sanitized Pi dynamic commands for a hot session", async () => {
    const { baseUrl, projectRoot, registry } = await makeServer();
    const created = await createSession(baseUrl, projectRoot);
    const handle = registry.getSession(created.id).handle as PiSessionHandle & { getCommands: ReturnType<typeof vi.fn> };
    handle.getCommands = vi.fn(async () => [
      { name: "litellm-refresh", source: "extension" as const, description: "Re-discover models from LiteLLM" },
      { name: "skill:brave-search", source: "skill" as const },
      { name: "../evil", source: "extension" as const },
    ]);

    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/commands`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      commands: [
        expect.objectContaining({ name: "litellm-refresh", source: "extension" }),
        expect.objectContaining({ name: "skill:brave-search", source: "skill" }),
      ],
    });
  });

  it("runs a generic slash command through the session handle", async () => {
    const { baseUrl, projectRoot, registry } = await makeServer();
    const created = await createSession(baseUrl, projectRoot);
    const handle = registry.getSession(created.id).handle as PiSessionHandle & { runPiSlashCommand: ReturnType<typeof vi.fn> };
    handle.runPiSlashCommand = vi.fn(async () => undefined);

    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/pi-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "/litellm-refresh --force  now" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(handle.runPiSlashCommand).toHaveBeenCalledWith("/litellm-refresh --force  now");
  });

  it("returns an empty command list when a session adapter does not support dynamic Pi commands", async () => {
    const { baseUrl, projectRoot } = await makeServer();
    const created = await createSession(baseUrl, projectRoot);

    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/commands`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ commands: [] });
  });

  it("rejects invalid generic slash command requests", async () => {
    const { baseUrl, projectRoot } = await makeServer();
    const created = await createSession(baseUrl, projectRoot);

    for (const body of [{}, { text: "" }, { text: "hello" }, { text: "/" }, { text: "/ model" }]) {
      const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/pi-command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });
});

async function makeServer(): Promise<{ readonly baseUrl: string; readonly projectRoot: string; readonly registry: SessionRegistry }> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-command-route-"));
  tempRoots.push(tmpRoot);
  const projectRoot = path.join(tmpRoot, "project");
  const sessionRoot = path.join(tmpRoot, "sessions");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  return { baseUrl: await listen(server), projectRoot, registry };
}

async function createSession(baseUrl: string, cwd: string): Promise<{ readonly id: string }> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, sessionName: "Pi command route" }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string }>;
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
