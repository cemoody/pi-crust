import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapPrcExtensions } from "../../src/extensions/bootstrap.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const EXTENSION_PATH = path.resolve(process.cwd(), "extensions", "presentations");

const SEED_DECK = {
  id: "exec-brief",
  title: "Executive Signal Brief",
  subtitle: "Demand, weather, and pricing signals",
  slides: [
    { template: "title", title: "Executive Signal Brief", subtitle: "Hello" },
    {
      template: "title-bullets",
      title: "What changed",
      bullets: ["A", { text: "B", detail: "More" }],
      stats: [{ value: "12%", label: "Permits" }],
    },
    {
      // templated slide, must be read-only
      template: "html",
      html: "<section data-test=\"pre-rendered\">x</section>",
    },
  ],
} as const;

async function bootstrapWithSession(sessionId: string) {
  const root = await tempRoot("prc-presentations-edit-");
  const host = (
    await bootstrapPrcExtensions({
      configDir: path.join(root, "config"),
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [EXTENSION_PATH],
      sessions: {
        create: async () => ({ id: sessionId, cwd: root }),
        get: async () => ({ id: sessionId, cwd: root }),
      },
    })
  ).host;
  return { root, host, sessionId };
}

function urlFor(sessionId: string, deckId: string): URL {
  return new URL(
    `http://localhost/api/sessions/${encodeURIComponent(sessionId)}/presentations/${encodeURIComponent(deckId)}/deck.json`,
  );
}

describe("core.presentations — deck persistence routes", () => {
  it("returns 404 when no persisted deck exists yet", async () => {
    const { host, sessionId } = await bootstrapWithSession("s1");
    const response = await host.serverRoutes.dispatch(
      ReadableRequest.empty("GET") as never,
      urlFor(sessionId, "exec-brief"),
    );
    expect(response?.status).toBe(404);
  });

  it("PUT writes an atomic envelope and a follow-up GET round-trips it", async () => {
    const { root, host, sessionId } = await bootstrapWithSession("s1");
    const putResponse = await host.serverRoutes.dispatch(
      ReadableRequest.withJson("PUT", { deck: SEED_DECK }) as never,
      urlFor(sessionId, "exec-brief"),
    );
    expect(putResponse?.status).toBe(200);

    const onDisk = path.join(root, ".pi", "presentations", sessionId, "exec-brief.deck.json");
    const raw = await fs.readFile(onDisk, "utf8");
    const envelope = JSON.parse(raw);
    expect(envelope.version).toBe(1);
    expect(envelope.deckId).toBe("exec-brief");
    expect(envelope.deck.title).toBe(SEED_DECK.title);
    expect(typeof envelope.updatedAt).toBe("number");

    // No leftover .tmp partial file
    const dirContents = await fs.readdir(path.dirname(onDisk));
    expect(dirContents.some((name) => name.endsWith(".tmp") || name.endsWith(".partial"))).toBe(false);

    const getResponse = await host.serverRoutes.dispatch(
      ReadableRequest.empty("GET") as never,
      urlFor(sessionId, "exec-brief"),
    );
    expect(getResponse?.status).toBe(200);
    const body = parseBody(getResponse?.body);
    expect(body.deck.title).toBe(SEED_DECK.title);
  });

  it("PUT rejects an invalid deck (e.g. blank title)", async () => {
    const { root, host, sessionId } = await bootstrapWithSession("s1");
    const bad = { ...SEED_DECK, title: "" };
    const response = await host.serverRoutes.dispatch(
      ReadableRequest.withJson("PUT", { deck: bad }) as never,
      urlFor(sessionId, "exec-brief"),
    );
    expect(response?.status).toBe(400);
    const file = path.join(root, ".pi", "presentations", sessionId, "exec-brief.deck.json");
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("PATCH applies allow-listed replace ops and writes them through", async () => {
    const { root, host, sessionId } = await bootstrapWithSession("s1");
    await host.serverRoutes.dispatch(
      ReadableRequest.withJson("PUT", { deck: SEED_DECK }) as never,
      urlFor(sessionId, "exec-brief"),
    );
    const response = await host.serverRoutes.dispatch(
      ReadableRequest.withJson("PATCH", {
        ops: [
          { op: "replace", path: "/slides/1/title", value: "Updated heading" },
          { op: "replace", path: "/slides/1/bullets/0", value: "Updated bullet" },
        ],
      }) as never,
      urlFor(sessionId, "exec-brief"),
    );
    expect(response?.status).toBe(200);
    const envelope = JSON.parse(
      await fs.readFile(path.join(root, ".pi", "presentations", sessionId, "exec-brief.deck.json"), "utf8"),
    );
    expect(envelope.deck.slides[1].title).toBe("Updated heading");
    expect(envelope.deck.slides[1].bullets[0]).toBe("Updated bullet");
  });

  it("PATCH lazily creates the presentations directory on first edit", async () => {
    const { root, host, sessionId } = await bootstrapWithSession("s1");
    // No PUT first — server must initialize from in-message-style deck supplied
    // alongside the patch (or accept an initial deck on PATCH body).
    const response = await host.serverRoutes.dispatch(
      ReadableRequest.withJson("PATCH", {
        initial: SEED_DECK,
        ops: [{ op: "replace", path: "/slides/1/title", value: "Lazy-created" }],
      }) as never,
      urlFor(sessionId, "exec-brief"),
    );
    expect(response?.status).toBe(200);
    const dir = path.join(root, ".pi", "presentations", sessionId);
    await expect(fs.access(dir)).resolves.toBeUndefined();
    const envelope = JSON.parse(await fs.readFile(path.join(dir, "exec-brief.deck.json"), "utf8"));
    expect(envelope.deck.slides[1].title).toBe("Lazy-created");
  });

  it("PATCH rejects non-allow-listed paths and leaves the file unchanged", async () => {
    const { root, host, sessionId } = await bootstrapWithSession("s1");
    await host.serverRoutes.dispatch(
      ReadableRequest.withJson("PUT", { deck: SEED_DECK }) as never,
      urlFor(sessionId, "exec-brief"),
    );
    const before = await fs.readFile(
      path.join(root, ".pi", "presentations", sessionId, "exec-brief.deck.json"),
      "utf8",
    );
    const response = await host.serverRoutes.dispatch(
      ReadableRequest.withJson("PATCH", {
        ops: [{ op: "replace", path: "/slides/2/html", value: "<b>injected</b>" }],
      }) as never,
      urlFor(sessionId, "exec-brief"),
    );
    expect(response?.status).toBe(400);
    const after = await fs.readFile(
      path.join(root, ".pi", "presentations", sessionId, "exec-brief.deck.json"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("rejects deckId path-escape attempts", async () => {
    const { host, sessionId } = await bootstrapWithSession("s1");
    for (const bad of ["..", "../../etc/passwd", "with/slash", "with\\backslash", ""]) {
      const response = await host.serverRoutes.dispatch(
        ReadableRequest.empty("GET") as never,
        new URL(
          `http://localhost/api/sessions/${encodeURIComponent(sessionId)}/presentations/${encodeURIComponent(bad)}/deck.json`,
        ),
      );
      // Either 400 (validated), 404 (treated as missing), or no route match
      // at all (undefined → http layer translates to 404) is acceptable. The
      // response MUST NOT be 200, and no escape should leak.
      const acceptable = response === undefined || response?.status === 400 || response?.status === 404;
      expect(acceptable).toBe(true);
    }
  });

  it("returns 404 when the session lookup fails", async () => {
    const root = await tempRoot("prc-presentations-edit-no-session-");
    const result = await bootstrapPrcExtensions({
      configDir: path.join(root, "config"),
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [EXTENSION_PATH],
      sessions: { create: async () => ({}), get: async () => { throw new Error("no such session"); } },
    });
    const response = await result.host.serverRoutes.dispatch(
      ReadableRequest.empty("GET") as never,
      urlFor("ghost", "exec-brief"),
    );
    expect(response?.status).toBe(404);
  });

  it("serializes concurrent PATCH writes (no lost updates, no corruption)", async () => {
    const { root, host, sessionId } = await bootstrapWithSession("s1");
    await host.serverRoutes.dispatch(
      ReadableRequest.withJson("PUT", { deck: SEED_DECK }) as never,
      urlFor(sessionId, "exec-brief"),
    );
    const N = 8;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        host.serverRoutes.dispatch(
          ReadableRequest.withJson("PATCH", {
            ops: [{ op: "replace", path: "/slides/1/title", value: `t-${i}` }],
          }) as never,
          urlFor(sessionId, "exec-brief"),
        ),
      ),
    );
    for (const r of responses) expect(r?.status).toBe(200);
    const envelope = JSON.parse(
      await fs.readFile(path.join(root, ".pi", "presentations", sessionId, "exec-brief.deck.json"), "utf8"),
    );
    expect(envelope.deck.slides[1].title).toMatch(/^t-\d+$/);
    // No partial files on disk
    const dirContents = await fs.readdir(path.join(root, ".pi", "presentations", sessionId));
    expect(dirContents.filter((n) => n.endsWith(".tmp") || n.endsWith(".partial"))).toEqual([]);
  });
});

function parseBody(body: unknown): { deck: { title: string } } {
  if (body && typeof body === "object" && "deck" in body) return body as { deck: { title: string } };
  if (typeof body === "string") return JSON.parse(body);
  if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString("utf8"));
  throw new Error("unexpected body shape: " + typeof body);
}

class ReadableRequest {
  method: string;
  headers: Record<string, string> = {};
  private payload: Buffer | undefined;
  private constructor(method: string, payload?: Buffer) {
    this.method = method;
    this.payload = payload;
    if (payload) this.headers["content-type"] = "application/json";
  }
  static empty(method: string): ReadableRequest {
    return new ReadableRequest(method);
  }
  static withJson(method: string, body: unknown): ReadableRequest {
    return new ReadableRequest(method, Buffer.from(JSON.stringify(body), "utf8"));
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    if (this.payload) yield this.payload;
  }
}
