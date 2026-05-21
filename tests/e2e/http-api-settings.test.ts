import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrcExtensionRuntime } from "../../src/extensions/runtime.js";
import { applyDottedSetting, createHttpApiServer } from "../../src/server/http-api-server.js";
import { readPrcSettings } from "../../src/extensions/packages.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("applyDottedSetting()", () => {
  it("sets a top-level key", () => {
    expect(applyDottedSetting({}, "theme", "dark")).toEqual({ theme: "dark" });
  });
  it("creates nested structure for dotted keys", () => {
    expect(applyDottedSetting({}, "presentations.templateDirs", ["/a"])).toEqual({
      presentations: { templateDirs: ["/a"] },
    });
  });
  it("merges existing siblings without dropping them", () => {
    const before = { presentations: { theme: "light" } };
    const after = applyDottedSetting(before, "presentations.templateDirs", ["/a"]);
    expect(after).toEqual({ presentations: { theme: "light", templateDirs: ["/a"] } });
    expect(before).toEqual({ presentations: { theme: "light" } }); // immutable input
  });
  it("removes the leaf when value is undefined/null/empty string", () => {
    const before = { presentations: { templateDirs: ["/a"] } };
    expect(applyDottedSetting(before, "presentations.templateDirs", undefined)).toEqual({ presentations: {} });
    expect(applyDottedSetting(before, "presentations.templateDirs", null)).toEqual({ presentations: {} });
    expect(applyDottedSetting(before, "presentations.templateDirs", "")).toEqual({ presentations: {} });
  });
});

describe("POST /api/settings", () => {
  it("persists a dotted-key array value to settings.json and reloads extensions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-settings-api-"));
    const configDir = path.join(root, "config");
    const baseUrl = await makeServer(configDir);
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "presentations.templateDirs", value: ["/x/y", "/p/q"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { settings: Record<string, unknown> };
    expect((body.settings.presentations as { templateDirs: string[] }).templateDirs).toEqual(["/x/y", "/p/q"]);
    const persisted = await readPrcSettings(configDir);
    expect(persisted.presentations?.templateDirs).toEqual(["/x/y", "/p/q"]);
  });
  it("rejects keys with invalid characters", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-settings-api-"));
    const baseUrl = await makeServer(path.join(root, "config"));
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "no spaces allowed", value: 1 }),
    });
    expect(response.status).toBe(400);
  });
});

async function makeServer(configDir: string): Promise<string> {
  const root = path.dirname(configDir);
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
  return new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server did not bind to TCP"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
