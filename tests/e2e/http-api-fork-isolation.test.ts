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
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("HTTP API fork isolation", () => {
  it("POST /fork creates a second hot session without replacing the source session", async () => {
    const { baseUrl, registry, projectRoot } = await makeServer();
    const source = await postJson<{ id: string }>(`${baseUrl}/api/sessions`, { cwd: projectRoot, sessionName: "source" });
    await postJson(`${baseUrl}/api/sessions/${encodeURIComponent(source.id)}/prompt`, { text: "original prompt" });
    const forkPoints = await getJson<Array<{ entryId: string; text: string }>>(`${baseUrl}/api/sessions/${encodeURIComponent(source.id)}/fork-messages`);

    const fork = await postJson<{ cancelled: boolean; text: string; session: { id: string } }>(`${baseUrl}/api/sessions/${encodeURIComponent(source.id)}/fork`, {
      entryId: forkPoints[0]!.entryId,
    });

    expect(fork).toMatchObject({ cancelled: false, text: "original prompt" });
    expect(fork.session.id).not.toBe(source.id);
    expect(registry.hasSession(source.id)).toBe(true);
    expect(registry.hasSession(fork.session.id)).toBe(true);
    expect(registry.hotSessionCount).toBe(2);
  });

  it("source SSE streams stay attached to the source and do not receive fork-only prompt events", async () => {
    const { baseUrl, projectRoot } = await makeServer();
    const source = await postJson<{ id: string }>(`${baseUrl}/api/sessions`, { cwd: projectRoot, sessionName: "source" });
    await postJson(`${baseUrl}/api/sessions/${encodeURIComponent(source.id)}/prompt`, { text: "original prompt" });
    const forkPoints = await getJson<Array<{ entryId: string; text: string }>>(`${baseUrl}/api/sessions/${encodeURIComponent(source.id)}/fork-messages`);

    const controller = new AbortController();
    const eventResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(source.id)}/events`, { signal: controller.signal });
    expect(eventResponse.ok).toBe(true);
    const reader = createSseReader(eventResponse);
    await reader.nextJson(); // ready event

    try {
      const fork = await postJson<{ session: { id: string } }>(`${baseUrl}/api/sessions/${encodeURIComponent(source.id)}/fork`, {
        entryId: forkPoints[0]!.entryId,
      });
      await postJson(`${baseUrl}/api/sessions/${encodeURIComponent(fork.session.id)}/prompt`, { text: "fork-only prompt" });

      await expect(reader.nextJson(
        (event) => event.type === "message" && event.message?.role === "user" && event.message?.content === "fork-only prompt",
        200,
      )).rejects.toThrow("Timed out waiting for matching SSE event");

      await postJson(`${baseUrl}/api/sessions/${encodeURIComponent(source.id)}/prompt`, { text: "source-only prompt" });
      await expect(reader.nextJson(
        (event) => event.type === "message" && event.message?.role === "user" && event.message?.content === "source-only prompt",
        1_000,
      )).resolves.toMatchObject({ type: "message", message: { role: "user", content: "source-only prompt" } });
    } finally {
      controller.abort();
    }
  });
});

async function makeServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-remote-fork-isolation-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  const baseUrl = await listen(server);
  return { baseUrl, registry, projectRoot, sessionRoot };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

async function getJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

function createSseReader(response: Response) {
  if (!response.body) throw new Error("Missing response body");
  const streamReader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queued: unknown[] = [];

  async function readOne(): Promise<unknown> {
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = raw.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (!data) continue;
        return JSON.parse(data);
      }
      const chunk = await streamReader.read();
      if (chunk.done) throw new Error("SSE stream ended before expected event");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return {
    async nextJson(predicate: (event: any) => boolean = () => true, timeoutMs = 2_000): Promise<any> {
      const queuedIndex = queued.findIndex((event) => predicate(event));
      if (queuedIndex !== -1) return queued.splice(queuedIndex, 1)[0];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const event = await Promise.race([
          readOne(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for matching SSE event")), remaining)),
        ]);
        if (predicate(event)) return event;
        queued.push(event);
      }
      throw new Error("Timed out waiting for matching SSE event");
    },
  };
}
