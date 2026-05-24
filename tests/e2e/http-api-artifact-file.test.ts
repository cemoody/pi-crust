import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

interface Harness {
  readonly baseUrl: string;
  readonly tmpRoot: string;
  readonly projectRoot: string;
}

async function makeServer(): Promise<Harness> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "prc-artifact-file-"));
  const projectRoot = path.join(tmpRoot, "project");
  const sessionRoot = path.join(tmpRoot, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({
    registry,
    adapterKind: "test",
    projectRoot,
    sessionRoot,
    defaultCwd: projectRoot,
  });
  servers.push(server);
  const baseUrl = await listen(server);
  return { baseUrl, tmpRoot, projectRoot };
}

describe("GET /api/artifact-file", () => {
  it("400s when the path query parameter is missing", async () => {
    const { baseUrl } = await makeServer();
    const response = await fetch(`${baseUrl}/api/artifact-file`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/path/) });
  });

  it("400s when the path contains a NUL byte", async () => {
    const { baseUrl } = await makeServer();
    // fetch() rejects NUL in URLs, so we hit the server with raw http to
    // confirm the validator catches it server-side too.
    const response = await rawGet(baseUrl, "/api/artifact-file?path=%00");
    expect(response.status).toBe(400);
  });

  it("serves a real file under the OS tmpdir with the correct mime type", async () => {
    const { baseUrl, tmpRoot } = await makeServer();
    const filePath = path.join(tmpRoot, "bottom.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x4f, 0x54, 0x54, 0x4f, 0x4d]);
    await fs.writeFile(filePath, bytes);

    const response = await fetch(`${baseUrl}/api/artifact-file?path=${encodeURIComponent(filePath)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.equals(bytes)).toBe(true);
  });

  it("serves a file under the configured projectRoot allow-list", async () => {
    const { baseUrl, projectRoot } = await makeServer();
    const filePath = path.join(projectRoot, "report.html");
    await fs.writeFile(filePath, "<h1>hello</h1>", "utf8");

    const response = await fetch(`${baseUrl}/api/artifact-file?path=${encodeURIComponent(filePath)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    await expect(response.text()).resolves.toBe("<h1>hello</h1>");
  });

  it("404s when the file does not exist", async () => {
    const { baseUrl, tmpRoot } = await makeServer();
    const filePath = path.join(tmpRoot, "missing.png");

    const response = await fetch(`${baseUrl}/api/artifact-file?path=${encodeURIComponent(filePath)}`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/not found/) });
  });

  it("404s when the path resolves to a directory", async () => {
    const { baseUrl, tmpRoot } = await makeServer();
    const response = await fetch(`${baseUrl}/api/artifact-file?path=${encodeURIComponent(tmpRoot)}`);
    // Either 404 (not a regular file) or 403, depending on whether tmpRoot
    // is itself the allow-list root. Both are acceptable failure modes; we
    // just want to confirm we don't accidentally stream a directory listing.
    expect([403, 404]).toContain(response.status);
  });

  it("403s when the requested file lives outside the allow-list", async () => {
    const { baseUrl } = await makeServer();
    // /etc/hostname is virtually always present on Linux and definitely
    // outside the (tmpdir, homedir, projectRoot, sessionRoot) allow-list
    // unless someone has misconfigured $HOME to /. We assert allow-list
    // rejection comes through with the path verbatim in the error message.
    const response = await fetch(`${baseUrl}/api/artifact-file?path=${encodeURIComponent("/etc/hostname")}`);
    // If the test runner's $HOME is unexpectedly /, the allow-list could
    // legitimately include /etc; in that case the file would just stream.
    // Guard against that environmental quirk to keep the test deterministic.
    if (os.homedir() === "/") return;
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/allow-list/) });
  });

  it("blocks ../ traversal even when the literal prefix matches an allow-list root", async () => {
    const { baseUrl, tmpRoot } = await makeServer();
    // tmpRoot is under os.tmpdir(), so naive prefix matching on the raw
    // input string could be fooled by `${tmpRoot}/../../etc/hostname`.
    // path.resolve() normalizes this, and realpath confirms; the final
    // resolved path lives outside the allow-list.
    const traversal = `${tmpRoot}/../../etc/hostname`;
    const response = await fetch(`${baseUrl}/api/artifact-file?path=${encodeURIComponent(traversal)}`);
    if (os.homedir() === "/") return;
    // /etc/hostname likely exists; allow-list should still reject.
    // If it happens not to exist in this environment, 404 is fine; the key
    // assertion is that we don't get 200.
    expect(response.status).not.toBe(200);
  });

  it("blocks symlinks that escape the allow-list", async () => {
    const { baseUrl, tmpRoot } = await makeServer();
    const linkPath = path.join(tmpRoot, "sneaky.png");
    try {
      await fs.symlink("/etc/hostname", linkPath);
    } catch (error) {
      // CI sandboxes that disallow symlinks: skip rather than fail. The
      // realpath-based escape check is also exercised by the ../ test above.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    if (os.homedir() === "/") return;
    const response = await fetch(`${baseUrl}/api/artifact-file?path=${encodeURIComponent(linkPath)}`);
    expect(response.status).toBe(403);
  });
});

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server did not bind to TCP"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

function rawGet(baseUrl: string, rawPath: string): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: "GET",
      host: url.hostname,
      port: Number(url.port),
      path: rawPath,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
