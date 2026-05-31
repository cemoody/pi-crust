import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

// ---------------------------------------------------------------------------
// Core session-route RESOLUTION contract.
//
// Many core HTTP routes resolve a session via getOrOpenSession(context, id) in
// src/server/http-api-server.ts (prompt, bash, abort, compact, reload, rename,
// model, pi-command, extension-ui-response, delete, and GET messages/commands/
// state). getOrOpenSession throws SessionNotFoundError (status 404) for an
// unknown id, and the top-level request handler in createHttpApiServer maps
// that to a 404 (otherwise a thrown error falls through to 500).
//
// The gap this file guards (proven by temporarily disabling the
// SessionNotFoundError -> 404 mapping and running the full suite: ONLY the
// branching cold-session test caught it):
//
//   1. The existing http-api-route-contract-matrix only sends EMPTY bodies to
//      /api/sessions/missing/..., so those requests 400 on BODY VALIDATION
//      before ever reaching getOrOpenSession -- session resolution is never
//      exercised. With a VALID body, an unknown id must be 404 (never 500).
//
//   2. A COLD (listed-but-unopened) session must be lazily reopened by the
//      resolving route (never 500 / never SessionNotFoundError-404).
//
// This file is the core-layer guard for both. It is deliberately small and
// surgical -- it does NOT re-cover auth/settings/sse/realtime (already covered).
// ---------------------------------------------------------------------------

const servers: http.Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

// Every core route that resolves its session through getOrOpenSession, with a
// VALID body so the request reaches session resolution (and is not short-
// circuited by body validation). `resolves: true` means the MockPiAdapter can
// fully service the route once the session resolves, so a COLD session yields a
// 2xx; `resolves: false` routes resolve the session but then hit an adapter
// capability the mock doesn't implement (runPiSlashCommand /
// respondToExtensionUi), so the cold case asserts the session was reopened
// rather than a specific status.
const ROUTES = [
  { name: "GET messages", method: "GET", action: "messages", body: undefined, resolves: true },
  { name: "GET commands", method: "GET", action: "commands", body: undefined, resolves: true },
  { name: "GET state", method: "GET", action: "state", body: undefined, resolves: true },
  { name: "POST prompt", method: "POST", action: "prompt", body: { text: "hi" }, resolves: true },
  { name: "POST bash", method: "POST", action: "bash", body: { command: "ls" }, resolves: true },
  { name: "POST abort", method: "POST", action: "abort", body: {}, resolves: true },
  { name: "POST compact", method: "POST", action: "compact", body: {}, resolves: true },
  { name: "POST reload", method: "POST", action: "reload", body: {}, resolves: true },
  { name: "POST rename", method: "POST", action: "rename", body: { name: "renamed" }, resolves: true },
  { name: "POST model", method: "POST", action: "model", body: { provider: "mock", modelId: "mock-1" }, resolves: true },
  { name: "POST delete", method: "POST", action: "delete", body: undefined, resolves: true },
  // These resolve the session, then the mock adapter rejects the operation
  // (no runPiSlashCommand / respondToExtensionUi). The cold case proves the
  // session was reopened; the unknown-id case still 404s (resolution fails
  // first, before the adapter is ever touched).
  { name: "POST pi-command", method: "POST", action: "pi-command", body: { text: "/help" }, resolves: false },
  { name: "POST extension-ui-response", method: "POST", action: "extension-ui-response", body: { id: "ui-1", confirmed: true }, resolves: false },
] as const;

describe("core session-route resolution", () => {
  // (1) Unknown id + VALID body -> 404 (never 500). This is the key gap the
  // existing contract matrix misses: those requests carry empty bodies and 400
  // on validation before reaching getOrOpenSession.
  it.each(ROUTES)("$name with a valid body -> 404 (never 500) for an unknown session id", async (route) => {
    const { baseUrl } = await makeServer();
    const response = await fetch(routeUrl(baseUrl, "no-such-session-id", route.action), {
      method: route.method,
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body), headers: { "content-type": "application/json" } }),
    });
    const text = await response.clone().text();
    expect(response.status, `${route.name}: expected 404 for unknown id, got ${response.status} ${text}`).toBe(404);
    // Explicitly pin the regression direction: a resolution regression must
    // NOT surface as a 500 stack leak.
    expect(response.status, `${route.name}: must never 500 on an unknown id`).not.toBe(500);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/unknown session/i) });
  });

  // (2) COLD (listed-but-unopened) session -> lazily reopened by the resolving
  // route (never 500, never the SessionNotFoundError-404). We assert the
  // session became hot again (proof the cold-open ran), and that the status is
  // a success for routes the mock can fully service.
  it.each(ROUTES)("$name lazily reopens a COLD (listed-but-unopened) session (never 500)", async (route) => {
    const { baseUrl, registry } = await makeServer();
    const coldId = await makeColdSession(baseUrl, registry);

    const response = await fetch(routeUrl(baseUrl, coldId, route.action), {
      method: route.method,
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body), headers: { "content-type": "application/json" } }),
    });
    const text = await response.clone().text();

    // The cold session must have been lazily reopened by getOrOpenSession.
    // (POST /delete is the one route that removes the session afterwards, so
    // it cannot be hot when we check -- success is asserted by status instead.)
    if (route.action !== "delete") {
      expect(registry.hasSession(coldId), `${route.name}: cold session must be lazily reopened (got ${response.status} ${text})`).toBe(true);
    }

    // It must never be the SessionNotFoundError 404 (it WAS resolvable as cold).
    if (response.status === 404) {
      await expect(response.json(), `${route.name}: a cold 404 must not be the unknown-session 404`).resolves.not.toMatchObject({ error: expect.stringMatching(/unknown session/i) });
    }

    if (route.resolves) {
      // Routes the mock fully services return a 2xx once the cold session opens,
      // and must never 500 -- a 500 here would mean resolution itself regressed.
      expect(response.status, `${route.name}: resolvable cold route should succeed, got ${response.status} ${text}`).toBeGreaterThanOrEqual(200);
      expect(response.status, `${route.name}: resolvable cold route should succeed, got ${response.status} ${text}`).toBeLessThan(300);
    } else {
      // These routes resolve the cold session, then hit an adapter capability
      // the mock doesn't implement -> a 500 carrying the adapter's specific
      // capability error (NOT a resolution failure). The point of the cold test
      // is that getOrOpenSession DID reopen the session (asserted above via
      // hasSession) and the error is downstream of resolution. Pin precisely:
      // any 500 must be the adapter-capability message, never an unknown-session
      // resolution error.
      if (response.status === 500) {
        await expect(response.json(), `${route.name}: cold 500 must be an adapter-capability error, not a resolution failure (${text})`).resolves.toMatchObject({ error: expect.stringMatching(/does not support/i) });
      }
    }
  });
});

async function makeColdSession(baseUrl: string, registry: SessionRegistry): Promise<string> {
  // Create via POST /api/sessions so the server records the session file in
  // coldSessionFiles (the production cold-resolution source), prompt it so it
  // has content, then dispose the hot handle so the ONLY path back to it is the
  // lazy cold-open inside getOrOpenSession. Mirrors the branching cold-session
  // setup in bundled-extension-packages.test.ts.
  const created = await fetchJson<{ id: string }>(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: registryProjectRoot(baseUrl), sessionName: "cold" }),
  });
  await registry.prompt(created.id, "seed the transcript");
  await registry.disposeSession(created.id);
  expect(registry.hasSession(created.id), "session must be cold (not in the in-memory map)").toBe(false);
  return created.id;
}

// The project root is fixed per-server (makeServer); stash it so makeColdSession
// can pass a valid cwd to POST /api/sessions.
const projectRootByBaseUrl = new Map<string, string>();
function registryProjectRoot(baseUrl: string): string {
  const root = projectRootByBaseUrl.get(baseUrl);
  if (!root) throw new Error(`no project root recorded for ${baseUrl}`);
  return root;
}

function routeUrl(baseUrl: string, id: string, action: string): string {
  const suffix = action === "state" ? "" : `/${action}`;
  return `${baseUrl}/api/sessions/${encodeURIComponent(id)}${suffix}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok, `${url} failed: ${response.status} ${await response.clone().text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function makeServer(): Promise<{ readonly baseUrl: string; readonly registry: SessionRegistry }> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-session-route-"));
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
  const baseUrl = await listen(server);
  projectRootByBaseUrl.set(baseUrl, projectRoot);
  return { baseUrl, registry };
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
