import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrcExtensionRuntime } from "../../src/extensions/runtime.js";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-prc-home.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const servers: http.Server[] = [];
const homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("bundled PRC extension packages", () => {
  it("serves artifact files from the bundled artifacts extension", async () => {
    const { baseUrl, home } = await startBundledServer(["artifacts"]);
    const session = await fetchJson<{ id: string; cwd: string }>(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: home.projectRoot }),
    });
    const artifactDir = path.join(home.projectRoot, ".pi", "artifacts", session.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, "plot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(fetchJson(`${baseUrl}/api/extensions`)).resolves.toMatchObject({
      routes: expect.arrayContaining([{ extensionId: "core.artifacts", method: "GET", path: "/api/sessions/:sessionId/artifacts/:file", mount: "api" }]),
    });
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/artifacts/plot.png`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves presentation files from the bundled presentations extension", async () => {
    const { baseUrl, home } = await startBundledServer(["presentations"]);
    const session = await fetchJson<{ id: string; cwd: string }>(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: home.projectRoot }),
    });
    const presentationDir = path.join(home.projectRoot, ".pi", "presentations", session.id);
    await fs.mkdir(presentationDir, { recursive: true });
    await fs.writeFile(path.join(presentationDir, "deck.html"), "<!doctype html><title>Deck</title>");

    await expect(fetchJson(`${baseUrl}/api/extensions`)).resolves.toMatchObject({
      routes: expect.arrayContaining([{ extensionId: "core.presentations", method: "GET", path: "/api/sessions/:sessionId/presentations/:file", mount: "api" }]),
    });
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/presentations/deck.html`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(response.text()).resolves.toContain("Deck");
  });

  it("serves fork and clone routes from the bundled branching extension", async () => {
    const { baseUrl, home } = await startBundledServer(["branching"]);
    const session = await fetchJson<{ id: string }>(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: home.projectRoot, sessionName: "source" }),
    });
    await fetchJson(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "make a plan" }),
    });

    await expect(fetchJson(`${baseUrl}/api/extensions`)).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({ extensionId: "core.branching", slashName: "fork" }),
        expect.objectContaining({ extensionId: "core.branching", slashName: "clone" }),
      ]),
      routes: expect.arrayContaining([
        { extensionId: "core.branching", method: "GET", path: "/api/sessions/:sessionId/fork-messages", mount: "api" },
        { extensionId: "core.branching", method: "POST", path: "/api/sessions/:sessionId/fork", mount: "api" },
        { extensionId: "core.branching", method: "POST", path: "/api/sessions/:sessionId/clone", mount: "api" },
      ]),
    });

    const messages = await fetchJson<Array<{ entryId: string; text: string }>>(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/fork-messages`);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("make a plan");

    const forked = await fetchJson<{ cancelled: boolean; text?: string; session: { id: string; sessionName?: string } }>(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId: messages[0]!.entryId }),
    });
    expect(forked.cancelled).toBe(false);
    expect(forked.text).toBe("make a plan");
    expect(forked.session.id).not.toBe(session.id);

    const cloned = await fetchJson<{ result: { prcAction: string; session: { id: string } } }>(`${baseUrl}/api/extensions/core.branching/commands/core.branching.clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    });
    expect(cloned.result.prcAction).toBe("openSession");
    expect(cloned.result.session.id).not.toBe(session.id);
  });
});

async function startBundledServer(packageNames: readonly string[]): Promise<{ baseUrl: string; home: TempPrcHome }> {
  const home = await createTempPrcHome();
  homes.push(home);
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot: home.sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [home.projectRoot], allowedSessionRoots: [home.sessionRoot] }),
  });
  const runtime = await createPrcExtensionRuntime({
    configDir: home.configDir,
    cwd: home.projectRoot,
    dataDir: home.dataDir,
    bundledPackagePaths: packageNames.map((name) => path.join(repoRoot, "extensions", name)),
    sessions: createSessionsApi(registry),
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
  return { baseUrl: await listen(server), home };
}

function createSessionsApi(registry: SessionRegistry) {
  return {
    create: async (input: { readonly cwd: string; readonly sessionName?: string }) => toCard(await (await registry.createSession(input)).handle.getState()),
    prompt: async (sessionId: string, prompt: string) => { await registry.prompt(sessionId, prompt); },
    get: async (sessionId: string) => toCard(await registry.getSession(sessionId).handle.getState()),
    getForkMessages: async (sessionId: string) => registry.getForkMessages(sessionId),
    forkSession: async (sessionId: string, entryId: string) => {
      const { result, session } = await registry.forkSession(sessionId, entryId);
      return { ...result, session: toCard(await session.handle.getState()) };
    },
    cloneSession: async (sessionId: string) => {
      const { result, session } = await registry.cloneSession(sessionId);
      return { ...result, session: toCard(await session.handle.getState()) };
    },
  };
}

function toCard(state: Awaited<ReturnType<import("../../src/server/pi/types.js").PiSessionHandle["getState"]>>) {
  return {
    id: state.id,
    cwd: state.cwd,
    sessionFile: state.sessionFile,
    sessionName: state.sessionName,
    status: state.status === "running" ? "streaming" : state.status,
    lastActivity: state.lastActivity,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
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
