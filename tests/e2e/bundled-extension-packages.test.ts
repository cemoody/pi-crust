import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createPrcExtensionRuntime } from "../../src/extensions/runtime.js";

const require_ = createRequire(import.meta.url);
function resolveExtDir(slug: string): string {
  return path.dirname(require_.resolve(`@cemoody/pi-crust-ext-${slug}/package.json`));
}
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const servers: http.Server[] = [];
const homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("bundled pi-crust extension packages", () => {
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
      routes: expect.arrayContaining([{ extensionId: "@cemoody/pi-crust-ext-artifacts", method: "GET", path: "/api/sessions/:sessionId/artifacts/:file", mount: "api" }]),
    });
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/artifacts/plot.png`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  // Regression guard for PR #205: the bundled artifacts extension resolves a
  // session's cwd via ctx.sessions.get(sessionId) to locate the artifact file
  // on disk. The production server wires that to a getOrOpenSession-style
  // resolver that LAZY-OPENS cold sessions (sessions that were listed but never
  // loaded into the in-memory registry). When the wiring regressed, cold
  // sessions returned HTTP 500 "session has no cwd". This test boots the
  // artifacts extension with a lazy-open sessions API, writes a session file
  // WITHOUT opening it (so it is cold), and asserts the route serves the bytes.
  it("serves artifact bytes for a COLD (listed-but-unopened) session", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["artifacts"], { lazyOpen: true });

    // Create + persist a session file, then dispose the hot handle so the only
    // way to resolve its cwd is the lazy cold-open path.
    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "cold" });
    const coldId = created.id;
    const artifactDir = path.join(home.projectRoot, ".pi", "artifacts", coldId);
    await fs.mkdir(artifactDir, { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(path.join(artifactDir, "cold.png"), pngBytes);
    await registry.disposeSession(coldId);
    expect(registry.hasSession(coldId), "session must be cold (not in the in-memory map)").toBe(false);

    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(coldId)}/artifacts/cold.png`);
    // The exact regression: this MUST NOT be 500 "session has no cwd".
    expect(response.status, `cold artifact request failed: ${response.status} ${await response.clone().text()}`).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...pngBytes]);
  });

  // A missing artifact file for a resolvable session must 404 (not 500), and an
  // entirely unknown session id must 404 (not 500) — so a regression in cwd
  // resolution can never masquerade as a generic not-found.
  it("returns 404 (never 500) for missing files and unknown sessions", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["artifacts"], { lazyOpen: true });
    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "present" });

    // Resolvable session, missing file -> 404 "artifact not found".
    const missing = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/artifacts/does-not-exist.png`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.not.toMatchObject({ error: "session has no cwd" });

    // Unknown session id -> 404, never 500.
    const unknown = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent("no-such-session-id")}/artifacts/whatever.png`);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.not.toMatchObject({ error: "session has no cwd" });
  });

  // Path-traversal hardening on the extension-mounted route. The route lives
  // outside the core security-boundary-matrix, so pin it independently: a
  // filename containing a path separator or `..` must be rejected and can never
  // read a sibling file outside the session's artifact dir.
  it("rejects path-traversal artifact filenames", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["artifacts"], { lazyOpen: true });
    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "sec" });
    // Plant a secret OUTSIDE the artifacts dir that traversal would target.
    await fs.writeFile(path.join(home.projectRoot, "secret.txt"), "top secret");

    const id = encodeURIComponent(created.id);
    for (const evil of ["..%2Fsecret.txt", "..%2F..%2Fsecret.txt", "foo%2Fbar.png", "%2Fetc%2Fpasswd"]) {
      const resp = await fetch(`${baseUrl}/api/sessions/${id}/artifacts/${evil}`);
      expect([400, 404], `path-traversal '${evil}' must be rejected, got ${resp.status}`).toContain(resp.status);
      const text = await resp.text();
      expect(text).not.toContain("top secret");
    }
  });

  // A valid artifact filename in session A must never be served from session B's
  // directory: the route keys the on-disk path by the URL's sessionId, so a
  // mismatched session must 404 rather than leak another session's bytes.
  it("does not serve one session's artifact bytes under another session's id", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["artifacts"], { lazyOpen: true });
    const owner = await registry.createSession({ cwd: home.projectRoot, sessionName: "owner" });
    const other = await registry.createSession({ cwd: home.projectRoot, sessionName: "other" });
    const ownerDir = path.join(home.projectRoot, ".pi", "artifacts", owner.id);
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(path.join(ownerDir, "only-owner.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Owner can read it.
    const ok = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(owner.id)}/artifacts/only-owner.png`);
    expect(ok.status).toBe(200);
    // The other session cannot — the file does not exist under its own dir.
    const leak = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(other.id)}/artifacts/only-owner.png`);
    expect(leak.status).toBe(404);
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

    const extensionsView = await fetchJson<{ routes: unknown[]; settings: Array<{ extensionId: string; title: string; webModuleUrl?: string }>; activities: Array<{ extensionId: string }> }>(`${baseUrl}/api/extensions`);
    expect(extensionsView).toMatchObject({
      routes: expect.arrayContaining([{ extensionId: "@cemoody/pi-crust-ext-presentations", method: "GET", path: "/api/sessions/:sessionId/presentations/:file", mount: "api" }]),
    });
    // The presentations extension never registers a sidebar activity; it ships
    // its Settings UI as a contributed section. We only positively assert the
    // section/webModule when the installed extension is new enough to expose it
    // (>=0.1.2). Older published versions still satisfy the no-activity half of
    // the contract; the rest is pinned by the unit-level contract test against
    // a fixture extension.
    expect(extensionsView.activities.find((a) => a.extensionId === "@cemoody/pi-crust-ext-presentations")).toBeUndefined();
    const contributedSection = (extensionsView.settings ?? []).find((s) => s.extensionId === "@cemoody/pi-crust-ext-presentations");
    if (contributedSection) {
      expect(contributedSection.title).toMatch(/.+/);
      expect(contributedSection.webModuleUrl).toMatch(/^\/api\/extensions\/.+\/assets\/.+/);
    }
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/presentations/deck.html`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(response.text()).resolves.toContain("Deck");
  });

  it("loads the bundled PR Story extension", async () => {
    const { baseUrl } = await startBundledServer(["pr-story"]);

    const extensionsView = await fetchJson<{ routes: unknown[]; activities: Array<{ extensionId: string }>; diagnostics: unknown[] }>(`${baseUrl}/api/extensions`);
    expect(extensionsView).toMatchObject({ diagnostics: [] });
    expect(extensionsView.activities.find((a) => a.extensionId === "@cemoody/pi-crust-ext-pr-story")).toBeUndefined();
    expect(extensionsView.routes).toEqual(expect.arrayContaining([
      { extensionId: "@cemoody/pi-crust-ext-pr-story", method: "GET", path: "/api/sessions/:sessionId/pr-story/:storyId", mount: "api" },
      { extensionId: "@cemoody/pi-crust-ext-pr-story", method: "POST", path: "/api/sessions/:sessionId/pr-story/:storyId/comments/submit", mount: "api" },
    ]));
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
        expect.objectContaining({ extensionId: "@cemoody/pi-crust-ext-branching", slashName: "fork" }),
        expect.objectContaining({ extensionId: "@cemoody/pi-crust-ext-branching", slashName: "clone" }),
      ]),
      routes: expect.arrayContaining([
        { extensionId: "@cemoody/pi-crust-ext-branching", method: "GET", path: "/api/sessions/:sessionId/fork-messages", mount: "api" },
        { extensionId: "@cemoody/pi-crust-ext-branching", method: "POST", path: "/api/sessions/:sessionId/fork", mount: "api" },
        { extensionId: "@cemoody/pi-crust-ext-branching", method: "POST", path: "/api/sessions/:sessionId/clone", mount: "api" },
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

    const cloned = await fetchJson<{ result: { prcAction: string; session: { id: string } } }>(`${baseUrl}/api/extensions/${encodeURIComponent("@cemoody/pi-crust-ext-branching")}/commands/core.branching.clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    });
    expect(cloned.result.prcAction).toBe("openSession");
    expect(cloned.result.session.id).not.toBe(session.id);
  });
});

async function startBundledServer(
  packageNames: readonly string[],
  options: { readonly lazyOpen?: boolean } = {},
): Promise<{ baseUrl: string; home: TempPrcHome; registry: SessionRegistry }> {
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
    bundledPackagePaths: packageNames.map((name) => resolveExtDir(name)),
    sessions: options.lazyOpen ? createLazyOpenSessionsApi(registry) : createSessionsApi(registry),
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
  return { baseUrl: await listen(server), home, registry };
}

// Mirrors the production wiring (startDefaultServer -> bindSessionResolver ->
// getOrOpenSession): resolve a session's card, lazily OPENING it from disk when
// it is cold (listed but not in the in-memory map). This is the exact behavior
// PR #205 added so the artifacts route can read a cold session's cwd.
function createLazyOpenSessionsApi(registry: SessionRegistry) {
  const resolve = async (sessionId: string) => {
    if (registry.hasSession(sessionId)) return registry.getSession(sessionId);
    // Cold path: find the persisted file via listSessions and open it.
    const listed = await registry.listSessions();
    const match = listed.find((s) => s.id === sessionId);
    if (!match) throw new Error(`Unknown session: ${sessionId}`);
    return registry.openSession(match.sessionFile);
  };
  return {
    ...createSessionsApi(registry),
    get: async (sessionId: string) => toCard(await (await resolve(sessionId)).handle.getState()),
  };
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
