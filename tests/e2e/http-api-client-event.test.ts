import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

// The reload investigation needs concrete evidence of *what* happened on the
// client at the moment of a "refresh" \u2014 navigation type, visibility transitions,
// SSE open/error events. The client posts those to /api/client-event, and the
// server appends one JSON line per event to a log file we can tail.

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-remote-clientevent-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const clientEventLog = path.join(root, "client-events.jsonl");
  const server = createHttpApiServer({
    registry,
    adapterKind: "test",
    projectRoot,
    sessionRoot,
    defaultCwd: projectRoot,
    clientEventLogPath: clientEventLog,
  });
  servers.push(server);
  const baseUrl = await listen(server);
  return { baseUrl, clientEventLog, projectRoot };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

describe("POST /api/client-event", () => {
  it("accepts JSON and appends one timestamped JSON line per event", async () => {
    const { baseUrl, clientEventLog } = await setup();

    const r1 = await fetch(`${baseUrl}/api/client-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "boot", navigationType: "reload", bootCount: 7, sessionId: "s1" }),
    });
    expect(r1.status).toBe(204);

    const r2 = await fetch(`${baseUrl}/api/client-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "sse-error", sessionId: "s1", readyState: 0 }),
    });
    expect(r2.status).toBe(204);

    const raw = await fs.readFile(clientEventLog, "utf8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      kind: "boot",
      navigationType: "reload",
      bootCount: 7,
      sessionId: "s1",
    });
    expect(typeof lines[0].serverTs).toBe("number");
    expect(typeof lines[0].ua).toBe("string");
    expect(lines[1]).toMatchObject({ kind: "sse-error", sessionId: "s1", readyState: 0 });
  });

  it("accepts text/plain bodies (sendBeacon falls back to Blob with text/plain)", async () => {
    const { baseUrl, clientEventLog } = await setup();

    const response = await fetch(`${baseUrl}/api/client-event`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ kind: "pagehide", persisted: true }),
    });
    expect(response.status).toBe(204);

    const raw = await fs.readFile(clientEventLog, "utf8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "pagehide", persisted: true });
  });

  it("rejects oversized payloads", async () => {
    const { baseUrl } = await setup();
    const huge = "x".repeat(20_000);
    const response = await fetch(`${baseUrl}/api/client-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "boot", junk: huge }),
    });
    expect(response.status).toBe(413);
  });

  it("rejects malformed JSON with 400 and writes nothing", async () => {
    const { baseUrl, clientEventLog } = await setup();
    const response = await fetch(`${baseUrl}/api/client-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });
    expect(response.status).toBe(400);
    const exists = await fs.stat(clientEventLog).then(() => true, () => false);
    expect(exists).toBe(false);
  });
});

describe("SSE lifecycle logging", () => {
  it("appends sse-open and sse-close events with a session id and a lifetime", async () => {
    const { baseUrl, clientEventLog, projectRoot } = await setupWithProject();

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot }),
    });
    expect(createResponse.ok).toBe(true);
    const { id: sessionId } = await createResponse.json() as { id: string };

    const controller = new AbortController();
    const sse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`, { signal: controller.signal });
    expect(sse.ok).toBe(true);
    // Hold the stream open briefly so the lifetimeMs is non-zero.
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    // Server needs a tick to flush the close log entry.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const raw = await fs.readFile(clientEventLog, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const opens = lines.filter((line) => line.kind === "sse-open");
    const closes = lines.filter((line) => line.kind === "sse-close");
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(opens[0]).toMatchObject({ kind: "sse-open", sessionId });
    expect(closes[0]).toMatchObject({ kind: "sse-close", sessionId });
    expect(typeof closes[0]!.lifetimeMs).toBe("number");
    expect(closes[0]!.lifetimeMs).toBeGreaterThanOrEqual(20);
  });
});

async function setupWithProject() {
  const base = await setup();
  return { ...base, projectRoot: base.projectRoot };
}
