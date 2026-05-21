import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapPrcExtensions } from "../../src/extensions/bootstrap.js";
import { writePrcSettings } from "../../src/extensions/packages.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("bundled core.presentations server extension", () => {
  it("does not register presentation routes when disabled", async () => {
    const root = await tempRoot("prc-presentations-disabled-");
    const configDir = path.join(root, "config");
    await writePrcSettings(configDir, { disabledExtensions: ["core.presentations"] });

    const result = await bootstrapPrcExtensions({
      configDir,
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [path.resolve(process.cwd(), "extensions", "presentations")],
    });

    expect(await result.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/sessions/s1/presentations/deck.html"))).toBeUndefined();
  });

  it("serves only safe presentation files from the session presentation directory", async () => {
    const root = await tempRoot("prc-presentations-route-");
    const sessionId = "session-1";
    const presentationDir = path.join(root, ".pi", "presentations", sessionId);
    await fs.mkdir(presentationDir, { recursive: true });
    await fs.writeFile(path.join(presentationDir, "deck.html"), "<!doctype html><title>Deck</title>");
    await fs.writeFile(path.join(presentationDir, "deck.json"), JSON.stringify({ ok: true }));

    const result = await bootstrapPrcExtensions({
      configDir: path.join(root, "config"),
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [path.resolve(process.cwd(), "extensions", "presentations")],
      sessions: { create: async () => ({ id: sessionId, cwd: root }), get: async () => ({ id: sessionId, cwd: root }) },
    });

    const html = await result.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL(`http://localhost/api/sessions/${sessionId}/presentations/deck.html`));
    expect(html?.status).toBe(200);
    expect(html?.headers?.["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(String(html?.body)).toContain("Deck");

    const json = await result.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL(`http://localhost/api/sessions/${sessionId}/presentations/deck.json`));
    expect(json?.headers?.["Content-Type"]).toBe("application/json; charset=utf-8");

    const invalid = await result.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL(`http://localhost/api/sessions/${sessionId}/presentations/bad%5Cname.html`));
    expect(invalid?.status).toBe(400);

    const missing = await result.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL(`http://localhost/api/sessions/${sessionId}/presentations/missing.html`));
    expect(missing?.status).toBe(404);
  });

  it("reports unknown sessions and malformed session state safely", async () => {
    const root = await tempRoot("prc-presentations-session-");
    const extensionPath = path.resolve(process.cwd(), "extensions", "presentations");
    const unknown = await bootstrapPrcExtensions({
      configDir: path.join(root, "config-unknown"),
      cwd: root,
      dataDir: path.join(root, "data-unknown"),
      bundledPackagePaths: [extensionPath],
      sessions: { create: async () => ({}), get: async () => { throw new Error("no such session"); } },
    });
    const unknownResponse = await unknown.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/sessions/missing/presentations/deck.html"));
    expect(unknownResponse?.status).toBe(404);
    expect(unknownResponse?.body).toMatchObject({ error: "no such session" });

    const malformed = await bootstrapPrcExtensions({
      configDir: path.join(root, "config-malformed"),
      cwd: root,
      dataDir: path.join(root, "data-malformed"),
      bundledPackagePaths: [extensionPath],
      sessions: { create: async () => ({}), get: async () => ({ id: "s1" }) },
    });
    const malformedResponse = await malformed.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/sessions/s1/presentations/deck.html"));
    expect(malformedResponse?.status).toBe(500);
  });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

class ReadableRequest {
  method: string;
  headers: Record<string, string> = {};
  private constructor(method: string) { this.method = method; }
  static empty(method: string): ReadableRequest { return new ReadableRequest(method); }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {}
}
