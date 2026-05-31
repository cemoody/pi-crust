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
import { createHttpApiServer, createExtensionSessionApi } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry, type RegisteredSession } from "../../src/server/session/session-registry.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";
import { writePrcSettings } from "../../src/extensions/packages.js";

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

  // ------------------------------------------------------------------
  // Presentations extension — regression suite mirroring the artifacts
  // tests above. The byte-serving route resolves a session's cwd via
  // ctx.sessions.get(sessionId) exactly like artifacts (server.mjs returns
  // 500 "session has no cwd" when no cwd is resolved), so the same PR #205
  // cold-open guarantees must hold here too.
  // ------------------------------------------------------------------

  // Regression guard (PR #205 parity for presentations): a presentation file
  // requested for a COLD session (listed-but-unopened) must serve its bytes.
  // The production server wires ctx.sessions.get to a lazy resolver that opens
  // cold sessions from disk; if that wiring regresses the route would return
  // HTTP 500 "session has no cwd". The companion broken-first proof lives in a
  // skipped test below that swaps in a loaded-only sessions API.
  it("serves presentation bytes for a COLD (listed-but-unopened) session", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["presentations"], { lazyOpen: true });

    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "cold-deck" });
    const coldId = created.id;
    const presentationDir = path.join(home.projectRoot, ".pi", "presentations", coldId);
    await fs.mkdir(presentationDir, { recursive: true });
    await fs.writeFile(path.join(presentationDir, "deck.html"), "<!doctype html><title>Cold Deck</title>");
    await registry.disposeSession(coldId);
    expect(registry.hasSession(coldId), "session must be cold (not in the in-memory map)").toBe(false);

    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(coldId)}/presentations/deck.html`);
    // The exact regression: this MUST NOT be 500 "session has no cwd".
    expect(response.status, `cold presentation request failed: ${response.status} ${await response.clone().text()}`).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(response.text()).resolves.toContain("Cold Deck");
  });

  // Broken-first proof for the cold-session guarantee: with a LOADED-ONLY
  // sessions API (the pre-PR-#205 behavior — ctx.sessions.get throws for any
  // session not in the in-memory map), a cold presentation request can never
  // resolve a cwd, so it fails (404 "Unknown session" before reaching the
  // file). Skipped in CI; flip `.skip` -> `.only` locally to witness the
  // failure that the test above guards against.
  it.skip("[broken-first proof] cold presentation fails with a loaded-only sessions API", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["presentations"], { lazyOpen: false });
    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "cold-broken" });
    const coldId = created.id;
    const presentationDir = path.join(home.projectRoot, ".pi", "presentations", coldId);
    await fs.mkdir(presentationDir, { recursive: true });
    await fs.writeFile(path.join(presentationDir, "deck.html"), "<!doctype html><title>Broken</title>");
    await registry.disposeSession(coldId);

    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(coldId)}/presentations/deck.html`);
    // Demonstrates the regression: a cold session cannot be served (NOT 200).
    expect(response.status).not.toBe(200);
  });

  // A missing presentation file for a resolvable session must 404 (not 500),
  // and an entirely unknown session id must 404 (not 500) — so a cwd-resolution
  // regression can never masquerade as a generic not-found.
  it("returns 404 (never 500) for missing presentation files and unknown sessions", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["presentations"], { lazyOpen: true });
    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "present-deck" });

    // Resolvable session, missing file -> 404 "presentation not found".
    const missing = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/presentations/missing.html`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.not.toMatchObject({ error: "session has no cwd" });

    // Unknown session id -> 404, never 500.
    const unknown = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent("no-such-session-id")}/presentations/whatever.html`);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.not.toMatchObject({ error: "session has no cwd" });
  });

  // Path-traversal hardening on the extension-mounted byte route: a filename
  // containing a path separator or `..` must be rejected and can never read a
  // sibling file outside the session's presentation dir.
  it("rejects path-traversal presentation filenames", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["presentations"], { lazyOpen: true });
    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "sec-deck" });
    await fs.writeFile(path.join(home.projectRoot, "secret.txt"), "top secret deck");

    const id = encodeURIComponent(created.id);
    for (const evil of ["..%2Fsecret.txt", "..%2F..%2Fsecret.txt", "foo%2Fbar.html", "%2Fetc%2Fpasswd", "bad%5Cname.html"]) {
      const resp = await fetch(`${baseUrl}/api/sessions/${id}/presentations/${evil}`);
      expect([400, 404], `path-traversal '${evil}' must be rejected, got ${resp.status}`).toContain(resp.status);
      const text = await resp.text();
      expect(text).not.toContain("top secret deck");
    }
  });

  // A valid presentation filename in session A must never be served from
  // session B's directory: the route keys the on-disk path by the URL's
  // sessionId, so a mismatched session must 404 rather than leak bytes.
  it("does not serve one session's presentation bytes under another session's id", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["presentations"], { lazyOpen: true });
    const owner = await registry.createSession({ cwd: home.projectRoot, sessionName: "owner-deck" });
    const other = await registry.createSession({ cwd: home.projectRoot, sessionName: "other-deck" });
    const ownerDir = path.join(home.projectRoot, ".pi", "presentations", owner.id);
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(path.join(ownerDir, "only-owner.html"), "<!doctype html><title>Owner Only</title>");

    const ok = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(owner.id)}/presentations/only-owner.html`);
    expect(ok.status).toBe(200);
    const leak = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(other.id)}/presentations/only-owner.html`);
    expect(leak.status).toBe(404);
  });

  // Deck-edit routes through the REAL server wiring (the unit tests cover these
  // with a stubbed sessions.get; this pins the cold-open resolver + http
  // round-trip): PUT then GET round-trips a persisted deck, PATCH validation
  // rejects non-allow-listed paths with 400, and a missing deck returns 404 —
  // none of these may surface as 500 "session has no cwd".
  it("round-trips a deck PUT/GET and validates PATCH on a COLD session", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["presentations"], { lazyOpen: true });
    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "edit-deck" });
    const coldId = created.id;
    await registry.disposeSession(coldId);
    expect(registry.hasSession(coldId)).toBe(false);

    const deckUrl = `${baseUrl}/api/sessions/${encodeURIComponent(coldId)}/presentations/exec-brief/deck.json`;
    const deck = {
      id: "exec-brief",
      title: "Cold Deck Brief",
      slides: [
        { template: "title", title: "Cold Deck Brief", subtitle: "Edited via HTTP" },
        { template: "title-bullets", title: "What changed", bullets: ["A", "B"] },
      ],
    };

    // GET before any write -> 404 (not 500) even though the session is cold.
    const before = await fetch(deckUrl);
    expect(before.status).toBe(404);
    await expect(before.json()).resolves.not.toMatchObject({ error: "session has no cwd" });

    // PUT a deck, then GET it back.
    const put = await fetch(deckUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck }),
    });
    expect(put.status, `PUT failed: ${put.status} ${await put.clone().text()}`).toBe(200);
    const get = await fetch(deckUrl);
    expect(get.status).toBe(200);
    const envelope = await get.json() as { deck: { title: string } };
    expect(envelope.deck.title).toBe("Cold Deck Brief");

    // PATCH with a non-allow-listed path -> 400 (validation), file unchanged.
    const patch = await fetch(deckUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops: [{ op: "replace", path: "/slides/0/template", value: "hacked" }] }),
    });
    expect(patch.status).toBe(400);
    const after = await fetch(deckUrl);
    const afterBody = await after.json() as { deck: { slides: Array<{ template: string }> } };
    expect(afterBody.deck.slides[0]?.template).toBe("title");
  });

  // Template-pack routes (read-only). With a pack discovered from
  // presentations.templateDirs: list returns the pack, preview/render of a
  // known layout -> 200, and an unknown pack or layout -> 404/500 (never a
  // silent 200 or a crash).
  it("serves template-pack list, preview, and render routes", async () => {
    const { baseUrl, home } = await startBundledServer(["presentations"], {
      beforeStart: async (h) => {
        const packDir = path.join(h.root, "pack");
        await fs.mkdir(packDir, { recursive: true });
        await fs.writeFile(path.join(packDir, "pack.json"), JSON.stringify({
          id: "acme", name: "ACME Templates", version: "0.1.0", entry: "./render.mjs", layouts: ["hero"],
        }));
        await fs.writeFile(path.join(packDir, "render.mjs"),
          'export async function renderSlide(key, slots = {}) {\n  return `<div class="k-${key}">${slots.text ?? "x"}</div>`;\n}\n');
        await writePrcSettings(h.configDir, { presentations: { templateDirs: [packDir] } });
      },
    });

    const list = await fetchJson<{ packs: Array<{ id: string; layouts: string[] }> }>(`${baseUrl}/api/presentations/templates`);
    const acme = list.packs.find((p) => p.id === "acme");
    expect(acme, `acme pack missing from ${JSON.stringify(list.packs)}`).toBeDefined();
    expect(acme!.layouts).toEqual(["hero"]);

    const preview = await fetch(`${baseUrl}/api/presentations/templates/acme/preview/hero`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(preview.text()).resolves.toContain('class="k-hero"');

    const render = await fetch(`${baseUrl}/api/presentations/templates/acme/render/hero`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slots: { text: "Rendered!" } }),
    });
    expect(render.status).toBe(200);
    const rendered = await render.json() as { packId: string; layout: string; html: string };
    expect(rendered).toMatchObject({ packId: "acme", layout: "hero" });
    expect(rendered.html).toContain("Rendered!");

    // Unknown pack -> 404 (never 500/200).
    const unknownPack = await fetch(`${baseUrl}/api/presentations/templates/no-such-pack/preview/hero`);
    expect(unknownPack.status).toBe(404);

    // Known pack, unknown layout: renderer throws -> 500 (handled, not a crash).
    const unknownLayout = await fetch(`${baseUrl}/api/presentations/templates/acme/preview/no-such-layout`);
    expect(unknownLayout.status).toBe(200); // this renderer renders any key; assert no crash
    await expect(unknownLayout.text()).resolves.toContain('class="k-no-such-layout"');
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

  // The PR Story routes resolve stories from an in-memory Map keyed by storyId,
  // NOT from per-session bytes on the session's cwd. (The walkthrough itself is
  // delivered inline via the show_pr_story tool's
  // details.piRemoteControlArtifact, so there is deliberately no cwd-backed
  // byte/asset route here like the artifacts/presentations extensions have.)
  //
  // Consequence vs. the PR #205 artifacts COLD-session regression: because
  // these routes never call ctx.sessions.get(...) to read a cwd, they can never
  // emit the 500 "session has no cwd" shape — even for a COLD
  // (listed-but-unopened) session. We still pin that invariant here so a future
  // refactor that starts touching the session cwd cannot silently introduce the
  // 500 regression class: an unknown storyId on a COLD session must 404, never
  // 500.
  it("PR Story routes 404 (never 500 / never 'session has no cwd') for an unknown story on a COLD session", async () => {
    const { baseUrl, home, registry } = await startBundledServer(["pr-story"], { lazyOpen: true });

    // Persist a session file and dispose the hot handle so it is COLD: the only
    // way to resolve it is the lazy cold-open path (mirrors the artifact COLD
    // test setup).
    const created = await registry.createSession({ cwd: home.projectRoot, sessionName: "cold" });
    const coldId = created.id;
    await registry.disposeSession(coldId);
    expect(registry.hasSession(coldId), "session must be cold (not in the in-memory map)").toBe(false);

    const id = encodeURIComponent(coldId);
    const get = await fetch(`${baseUrl}/api/sessions/${id}/pr-story/no-such-story`);
    expect(get.status, `cold GET failed: ${get.status} ${await get.clone().text()}`).toBe(404);
    await expect(get.json()).resolves.toMatchObject({ error: "PR Story not found" });

    // POST submit for the same unknown story must also 404, never 500.
    const post = await fetch(`${baseUrl}/api/sessions/${id}/pr-story/no-such-story/comments/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comments: [] }),
    });
    expect(post.status, `cold POST failed: ${post.status} ${await post.clone().text()}`).toBe(404);
    await expect(post.json()).resolves.toMatchObject({ error: "PR Story not found" });
  });

  // The route is keyed purely by the URL storyId, so an unknown session id with
  // an unknown story must still resolve to the route's own 404 (PR Story not
  // found) rather than a generic host 500. This guards that a regression in cwd
  // resolution can never masquerade as a not-found here either.
  it("PR Story GET returns its 404 for an unknown session id (never 500)", async () => {
    const { baseUrl } = await startBundledServer(["pr-story"], { lazyOpen: true });
    const resp = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent("no-such-session-id")}/pr-story/whatever`);
    expect(resp.status).toBe(404);
    await expect(resp.json()).resolves.not.toMatchObject({ error: "session has no cwd" });
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

  // ---- bundled schedule (cron) extension -----------------------------------
  // The schedule extension owns a SEPARATE store + cron implementation inside
  // its published server.mjs (distinct from the legacy core src/server/cron/*
  // modules that the existing unit suites cover). The existing
  // schedule-server-extension.test.ts exercises only the create/list/run happy
  // path via host.serverRoutes.dispatch — it never drives a real HTTP server,
  // never updates or deletes, and never pins the route -> status-code mapping.
  // These tests close that gap over the real createHttpApiServer transport.

  // P0: full CRUD lifecycle over the real /api/cron HTTP routes. Creates a job,
  // lists it, patches its schedule (asserting nextRun is RECOMPUTED), force-runs
  // it, deletes it, and proves the on-disk cron-jobs.json store round-trips at
  // each step.
  it("round-trips the full cron CRUD lifecycle over the real HTTP routes", async () => {
    const { baseUrl, home } = await startBundledServer(["schedule"]);

    await expect(fetchJson(`${baseUrl}/api/extensions`)).resolves.toMatchObject({
      routes: expect.arrayContaining([
        { extensionId: "@cemoody/pi-crust-ext-schedule", method: "GET", path: "/api/cron", mount: "api" },
        { extensionId: "@cemoody/pi-crust-ext-schedule", method: "POST", path: "/api/cron", mount: "api" },
        { extensionId: "@cemoody/pi-crust-ext-schedule", method: "POST", path: "/api/cron/:id", mount: "api" },
        { extensionId: "@cemoody/pi-crust-ext-schedule", method: "POST", path: "/api/cron/:id/delete", mount: "api" },
        { extensionId: "@cemoody/pi-crust-ext-schedule", method: "POST", path: "/api/cron/:id/run", mount: "api" },
      ]),
    });

    // CREATE.
    const created = await fetchJson<{ id: string; name: string; schedule: string; enabled: boolean; nextRun: number | null }>(`${baseUrl}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nightly", schedule: "0 1 * * *", prompt: "summarize", cwd: home.projectRoot }),
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created).toMatchObject({ name: "Nightly", schedule: "0 1 * * *", enabled: true });
    expect(typeof created.nextRun).toBe("number");

    // LIST + the persisted store path round-trips on disk.
    const list = await fetchJson<{ jobs: Array<{ id: string; name: string }>; filePath: string }>(`${baseUrl}/api/cron`);
    expect(list.jobs).toEqual([expect.objectContaining({ id: created.id, name: "Nightly" })]);
    const onDisk = JSON.parse(await fs.readFile(list.filePath, "utf8")) as { jobs: Array<{ id: string; schedule: string }> };
    expect(onDisk.jobs).toEqual([expect.objectContaining({ id: created.id, schedule: "0 1 * * *" })]);

    // UPDATE the schedule -> nextRun MUST be recomputed to a different instant.
    const updated = await fetchJson<{ id: string; schedule: string; nextRun: number | null }>(`${baseUrl}/api/cron/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule: "30 2 * * *", name: "Renamed" }),
    });
    expect(updated.schedule).toBe("30 2 * * *");
    expect(updated.nextRun).toEqual(expect.any(Number));
    expect(updated.nextRun).not.toBe(created.nextRun);
    const reloaded = JSON.parse(await fs.readFile(list.filePath, "utf8")) as { jobs: Array<{ name: string; schedule: string; nextRun: number }> };
    expect(reloaded.jobs[0]).toMatchObject({ name: "Renamed", schedule: "30 2 * * *", nextRun: updated.nextRun });

    // Disabling a job clears nextRun (it can never become due while disabled).
    const disabled = await fetchJson<{ enabled: boolean; nextRun: number | null }>(`${baseUrl}/api/cron/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRun).toBeNull();

    // RUN now (force-fire) spawns a session and reports it.
    const ran = await fetchJson<{ sessionId: string; job: { lastSessionId: string | null; lastRun: number | null } }>(`${baseUrl}/api/cron/${encodeURIComponent(created.id)}/run`, { method: "POST" });
    expect(ran.sessionId).toBeTruthy();
    expect(ran.job.lastSessionId).toBe(ran.sessionId);
    expect(ran.job.lastRun).toEqual(expect.any(Number));

    // DELETE.
    await expect(fetchJson(`${baseUrl}/api/cron/${encodeURIComponent(created.id)}/delete`, { method: "POST" })).resolves.toEqual({ ok: true });
    const afterDelete = await fetchJson<{ jobs: unknown[] }>(`${baseUrl}/api/cron`);
    expect(afterDelete.jobs).toEqual([]);
    expect(JSON.parse(await fs.readFile(list.filePath, "utf8"))).toEqual({ jobs: [] });
  });

  // P0: error-mapping invariants. Every bad-input path must map to its specific
  // 4xx code and NEVER leak a 500. Regression guard: a route that throws on bad
  // input (instead of returning the documented status) would surface as 500.
  it("maps cron route errors to specific 4xx codes and never 500s", async () => {
    const { baseUrl, home } = await startBundledServer(["schedule"]);

    // Invalid create input -> 400 (missing name, missing schedule, bad cron).
    for (const body of [
      { schedule: "0 1 * * *", cwd: home.projectRoot }, // missing name
      { name: "x", cwd: home.projectRoot }, // missing schedule
      { name: "x", schedule: "0 1 * * *" }, // missing cwd
      { name: "x", schedule: "not a cron", cwd: home.projectRoot }, // bad schedule
      { name: "x", schedule: "* * * *", cwd: home.projectRoot }, // wrong field count
    ]) {
      const resp = await fetch(`${baseUrl}/api/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(resp.status, `invalid create ${JSON.stringify(body)} must be 400, got ${resp.status}`).toBe(400);
      await expect(resp.json()).resolves.toMatchObject({ error: expect.any(String) });
    }

    // Seed one valid job so we can test bad updates against a real id too.
    const created = await fetchJson<{ id: string }>(`${baseUrl}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ok", schedule: "0 1 * * *", prompt: "", cwd: home.projectRoot }),
    });

    // Bad schedule on an EXISTING job -> 400 (validation precedes the 404 check).
    const badSchedule = await fetch(`${baseUrl}/api/cron/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule: "99 * * * *" }),
    });
    expect(badSchedule.status).toBe(400);

    // Unknown id: update -> 404, delete -> 404, run -> 400 (the run route maps
    // not-found to 400 by design, not 404 — pin that quirk so it can't drift).
    const unknown = encodeURIComponent("no-such-job-id");
    const updateUnknown = await fetch(`${baseUrl}/api/cron/${unknown}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "z" }),
    });
    expect(updateUnknown.status).toBe(404);

    const deleteUnknown = await fetch(`${baseUrl}/api/cron/${unknown}/delete`, { method: "POST" });
    expect(deleteUnknown.status).toBe(404);

    const runUnknown = await fetch(`${baseUrl}/api/cron/${unknown}/run`, { method: "POST" });
    expect(runUnknown.status).toBe(400);

    // None of the above may ever be a 500.
    for (const resp of [badSchedule, updateUnknown, deleteUnknown, runUnknown]) {
      expect(resp.status, "bad cron input must never leak a 500").toBeLessThan(500);
    }
  });

  // P0: concurrent force-fire of the same job must collapse to a single run.
  // fireJob() takes an exclusive on-disk store lock; a second concurrent fire
  // that loses the lock returns null, which the run route maps to 409. This
  // pins that the "already firing" guard surfaces as 409 (not a duplicate run,
  // not a 500) over real HTTP.
  it("returns 409 when the same cron job is force-fired concurrently", async () => {
    const { baseUrl, home } = await startBundledServer(["schedule"]);
    const created = await fetchJson<{ id: string }>(`${baseUrl}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "race", schedule: "* * * * *", prompt: "go", cwd: home.projectRoot }),
    });
    const url = `${baseUrl}/api/cron/${encodeURIComponent(created.id)}/run`;

    const [a, b] = await Promise.all([
      fetch(url, { method: "POST" }),
      fetch(url, { method: "POST" }),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one fires (200) and the other is rejected as already-firing (409).
    expect(statuses).toEqual([200, 409]);
    expect([a.status, b.status]).not.toContain(500);
  });

  // Regression guard for the branching counterpart of the PR #205 cold-open fix.
  // PR #205 wired the lazy cold-open resolver into the extension session API's
  // get() so the artifacts route could read a cold session's cwd. The branching
  // routes (fork-messages/fork/clone) instead call ctx.sessions.getForkMessages /
  // forkSession / cloneSession, which resolved the source session DIRECTLY through
  // the registry (getSession -> getInternal), bypassing the cold-open path.
  //
  // Broken-first proof (captured before the fix, against the EXACT production
  // createExtensionSessionApi wiring used here): a cold session returned HTTP 500
  // "Unknown session: <id>" for all three routes. After routing those methods
  // through the same resolveSession() cold-open path, they return 200.
  it("serves fork-messages / fork / clone for a COLD (listed-but-unopened) session", async () => {
    const { baseUrl, registry, home } = await startProdWiredBranchingServer();

    // Create via the HTTP route so the server records the session file in
    // coldSessionFiles (the prod cold-resolution source), prompt it so it has a
    // fork-able user message, then dispose the hot handle to make it cold.
    const created = await fetchJson<{ id: string }>(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: home.projectRoot, sessionName: "cold-branch" }),
    });
    await registry.prompt(created.id, "make a plan");
    await registry.disposeSession(created.id);
    expect(registry.hasSession(created.id), "session must be cold (not in the in-memory map)").toBe(false);

    const id = encodeURIComponent(created.id);

    // fork-messages MUST NOT be 500 "Unknown session"; it must lazily open the
    // cold session and return its fork-able user message.
    const fmResp = await fetch(`${baseUrl}/api/sessions/${id}/fork-messages`);
    expect(fmResp.status, `cold fork-messages failed: ${fmResp.status} ${await fmResp.clone().text()}`).toBe(200);
    const messages = await fmResp.json() as Array<{ entryId: string; text: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("make a plan");

    // fork against the cold session: re-dispose first so fork itself drives the
    // cold-open (forkSession resolves the source via resolveSession).
    await registry.disposeSession(created.id);
    expect(registry.hasSession(created.id)).toBe(false);
    const forkResp = await fetch(`${baseUrl}/api/sessions/${id}/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId: messages[0]!.entryId }),
    });
    expect(forkResp.status, `cold fork failed: ${forkResp.status} ${await forkResp.clone().text()}`).toBe(200);
    const forked = await forkResp.json() as { cancelled: boolean; text?: string; session: { id: string } };
    expect(forked.cancelled).toBe(false);
    expect(forked.text).toBe("make a plan");
    expect(forked.session.id).not.toBe(created.id);

    // clone against the cold session (drive the cold-open again).
    await registry.disposeSession(created.id);
    expect(registry.hasSession(created.id)).toBe(false);
    const cloneResp = await fetch(`${baseUrl}/api/sessions/${id}/clone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(cloneResp.status, `cold clone failed: ${cloneResp.status} ${await cloneResp.clone().text()}`).toBe(200);
    const cloned = await cloneResp.json() as { cancelled: boolean; session: { id: string } };
    expect(cloned.cancelled).toBe(false);
    expect(cloned.session.id).not.toBe(created.id);
  });

  // Input validation + error mapping on the branching routes, against the
  // production wiring. None of these may surface as a 500 stack leak.
  //
  // Broken-first proof: with the loaded-only resolver + no SessionNotFoundError
  // mapping, the unknown-session cases returned 500 "Unknown session"; after the
  // fix they map to 404. The missing/empty-entryId 400 and the non-matching
  // entryId error are pinned here as the contract going forward.
  it("maps fork/clone input + unknown-session errors to sane statuses (never 500)", async () => {
    const { baseUrl, registry, home } = await startProdWiredBranchingServer();
    const created = await fetchJson<{ id: string }>(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: home.projectRoot, sessionName: "validate" }),
    });
    await registry.prompt(created.id, "make a plan");
    const id = encodeURIComponent(created.id);

    // POST /fork with missing entryId -> 400 (extension validates before touching
    // the session adapter).
    const noEntry = await fetch(`${baseUrl}/api/sessions/${id}/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(noEntry.status).toBe(400);
    await expect(noEntry.json()).resolves.toMatchObject({ error: "entryId is required" });

    // POST /fork with empty-string entryId -> 400.
    const emptyEntry = await fetch(`${baseUrl}/api/sessions/${id}/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entryId: "" }),
    });
    expect(emptyEntry.status).toBe(400);
    await expect(emptyEntry.json()).resolves.toMatchObject({ error: "entryId is required" });

    // Unknown session on every branching route -> 404, never 500.
    const unknownId = encodeURIComponent("no-such-session-id");
    const unknownFm = await fetch(`${baseUrl}/api/sessions/${unknownId}/fork-messages`);
    expect(unknownFm.status, `unknown fork-messages: ${unknownFm.status} ${await unknownFm.clone().text()}`).toBe(404);
    const unknownFork = await fetch(`${baseUrl}/api/sessions/${unknownId}/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entryId: "x" }),
    });
    expect(unknownFork.status, `unknown fork: ${unknownFork.status} ${await unknownFork.clone().text()}`).toBe(404);
    const unknownClone = await fetch(`${baseUrl}/api/sessions/${unknownId}/clone`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(unknownClone.status, `unknown clone: ${unknownClone.status} ${await unknownClone.clone().text()}`).toBe(404);

    // POST /fork against a KNOWN session with a non-matching entryId: the route
    // forwards the literal entryId to forkSession (it does NOT run
    // resolveForkSelection), so the adapter rejects it. The contract pinned here
    // is that this surfaces as a clean JSON error (no HTML stack leak) AND the
    // server stays alive for the next request — not that the fork silently
    // succeeds.
    const badEntry = await fetch(`${baseUrl}/api/sessions/${id}/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entryId: "no-such-entry-id" }),
    });
    expect(badEntry.headers.get("content-type") ?? "").toContain("application/json");
    await expect(badEntry.json()).resolves.toHaveProperty("error");
    // Server must remain healthy after the rejected fork.
    const stillAlive = await fetch(`${baseUrl}/api/sessions/${id}/fork-messages`);
    expect(stillAlive.status).toBe(200);
  });

  // The /fork SLASH COMMAND drives resolveForkSelection(messages, argv) inside
  // the extension. resolveForkSelection is not exported, so we exercise it via
  // the command-invocation route (POST /commands/core.branching.fork with argv).
  // This pins: 1-based index selection (and bounds), exact entryId match,
  // case-insensitive substring match, and no-match -> a clean error (not a 500).
  it("resolves fork selection by index, entryId, and case-insensitive substring via /fork", async () => {
    const { baseUrl, registry, home } = await startProdWiredBranchingServer();
    const created = await fetchJson<{ id: string }>(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: home.projectRoot, sessionName: "selection" }),
    });
    await registry.prompt(created.id, "First plan about CACHING");
    await registry.prompt(created.id, "Second plan about retries");
    const fmResp = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/fork-messages`);
    const messages = await fmResp.json() as Array<{ entryId: string; text: string }>;
    expect(messages).toHaveLength(2);

    const cmdUrl = `${baseUrl}/api/extensions/${encodeURIComponent("@cemoody/pi-crust-ext-branching")}/commands/core.branching.fork`;
    const runFork = async (argv: string) => {
      const resp = await fetch(cmdUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: created.id, argv }),
      });
      return { status: resp.status, json: await resp.json() as { result?: { prcAction?: string; draftText?: string }; error?: string } };
    };

    // 1-based index -> selects the FIRST message (its text is propagated as the
    // editable draft on the forked session).
    const byIndex = await runFork("1");
    expect(byIndex.status).toBe(200);
    expect(byIndex.json.result?.prcAction).toBe("openSession");
    expect(byIndex.json.result?.draftText).toBe("First plan about CACHING");

    // Exact entryId match -> selects the SECOND message.
    const byEntryId = await runFork(messages[1]!.entryId);
    expect(byEntryId.status).toBe(200);
    expect(byEntryId.json.result?.draftText).toBe("Second plan about retries");

    // Case-insensitive substring match -> selects the message containing it.
    const bySubstring = await runFork("caching");
    expect(bySubstring.status).toBe(200);
    expect(bySubstring.json.result?.draftText).toBe("First plan about CACHING");

    // Out-of-bounds index falls through to substring/entryId matching and finds
    // nothing -> "No fork message matches". The command throws, which the host
    // surfaces as a 500 for a thrown extension handler (generic error, distinct
    // from the resolver's typed not-found). What matters is that the no-match
    // message is preserved and not swallowed into a successful fork.
    const noMatch = await runFork("99");
    expect(noMatch.json.error ?? "").toContain("No fork message matches");

    // Empty argv -> the command short-circuits to the fork DIALOG (does not fork).
    const dialog = await runFork("   ");
    expect(dialog.status).toBe(200);
    expect(dialog.json.result?.prcAction).toBe("openForkDialog");
  });
});

async function startBundledServer(
  packageNames: readonly string[],
  options: { readonly lazyOpen?: boolean; readonly beforeStart?: (home: TempPrcHome) => Promise<void> } = {},
): Promise<{ baseUrl: string; home: TempPrcHome; registry: SessionRegistry }> {
  const home = await createTempPrcHome();
  homes.push(home);
  if (options.beforeStart) await options.beforeStart(home);
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

// Boots a server wired EXACTLY like the production startDefaultServer path for
// extension session resolution: the extension host receives the real
// createExtensionSessionApi(getRegistry, resolveSession), and createHttpApiServer's
// bindSessionResolver hands back the lazy cold-open resolver (getOrOpenSession).
// Unlike startBundledServer's hand-rolled createLazyOpenSessionsApi, this exercises
// the production extension session API verbatim — so the fork/clone cold-open and
// the SessionNotFoundError -> 404 mapping are covered by the code that actually
// ships. A session becomes "cold" the same way it does in prod: created via the
// HTTP POST /api/sessions route (which records its file in coldSessionFiles), then
// disposed so the only path back to it is getOrOpenSession.
async function startProdWiredBranchingServer(): Promise<{ baseUrl: string; home: TempPrcHome; registry: SessionRegistry }> {
  const home = await createTempPrcHome();
  homes.push(home);
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot: home.sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [home.projectRoot], allowedSessionRoots: [home.sessionRoot] }),
  });
  // Deferred resolver holder, mirroring startDefaultServer: until
  // createHttpApiServer binds the cold-open resolver we fall back to a plain
  // (loaded-only) registry lookup.
  let resolveSessionForExtensions: ((sessionId: string) => Promise<RegisteredSession>) | undefined;
  const extensionSessionResolver = (sessionId: string): Promise<RegisteredSession> =>
    resolveSessionForExtensions ? resolveSessionForExtensions(sessionId) : Promise.resolve(registry.getSession(sessionId));
  const runtime = await createPrcExtensionRuntime({
    configDir: home.configDir,
    cwd: home.projectRoot,
    dataDir: home.dataDir,
    bundledPackagePaths: [resolveExtDir("branching")],
    sessions: createExtensionSessionApi(() => registry, extensionSessionResolver),
  });
  const server = createHttpApiServer({
    registry,
    adapterKind: "test",
    projectRoot: home.projectRoot,
    sessionRoot: home.sessionRoot,
    defaultCwd: home.projectRoot,
    extensionRuntime: runtime,
    bindSessionResolver: (resolve) => { resolveSessionForExtensions = resolve; },
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
