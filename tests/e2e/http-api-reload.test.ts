import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { PiRpcAdapter } from "../../src/server/pi/pirpc-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];
const registries: SessionRegistry[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("HTTP session reload route", () => {
  it("POST /api/sessions/:id/reload restarts the Pi RPC worker on the same session", async () => {
    const { baseUrl, projectRoot, startLog } = await makeServer();
    const created = await fetchJson<{ id: string }>(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot, sessionName: "Reload route" }),
    });

    await expect(readStarts(startLog, 1)).resolves.toHaveLength(1);

    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    const card = await response.json() as { id?: string; sessionName?: string; status?: string };
    expect(card).toMatchObject({ id: created.id, sessionName: "Reload route", status: "idle" });

    await expect(readStarts(startLog, 2)).resolves.toEqual([
      expect.objectContaining({ sessionFileArg: null }),
      expect.objectContaining({ sessionFileArg: expect.stringContaining("reload-rpc-session.jsonl") }),
    ]);

    const messages = await fetchJson<Array<{ role?: string; text?: string }>>(`${baseUrl}/api/sessions/${encodeURIComponent(created.id)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "after reload" }),
    });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", text: "fake rpc response to: after reload" }),
    ]));
  }, 20_000);
});

async function makeServer(): Promise<{ readonly baseUrl: string; readonly projectRoot: string; readonly startLog: string }> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-reload-route-"));
  tempRoots.push(tmpRoot);
  const projectRoot = path.join(tmpRoot, "project");
  const sessionRoot = path.join(tmpRoot, "sessions");
  const runtimeDir = path.join(tmpRoot, "runtime");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(sessionRoot, { recursive: true });
  const { executable, startLog } = await makeFakePiRpcExecutable(tmpRoot);
  const adapter = new PiRpcAdapter({ piCommand: executable, sessionDir: sessionRoot, runtimeDir, artifactExtension: false });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  registries.push(registry);
  const server = createHttpApiServer({ registry, adapterKind: "pirpc", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  return { baseUrl: await listen(server), projectRoot, startLog };
}

async function makeFakePiRpcExecutable(root: string): Promise<{ readonly executable: string; readonly startLog: string }> {
  const fakeRpc = path.join(root, "fake-pi-rpc.mjs");
  const sessionFile = path.join(root, "sessions", "reload-rpc-session.jsonl");
  const startLog = path.join(root, "starts.jsonl");
  await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
  await fsp.writeFile(fakeRpc, `
import fs from "node:fs";
const defaultSessionFile = ${JSON.stringify(sessionFile)};
const startLog = ${JSON.stringify(startLog)};
const args = process.argv.slice(2);
const sessionArgIndex = args.indexOf("--session");
const sessionFile = sessionArgIndex >= 0 ? args[sessionArgIndex + 1] : defaultSessionFile;
const sessionId = "reload-rpc-session";
let name = "Reload route";
let buffer = "";
const messages = [];
fs.mkdirSync(${JSON.stringify(path.dirname(sessionFile))}, { recursive: true });
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd(), timestamp: Date.now() }) + "\\n");
fs.appendFileSync(startLog, JSON.stringify({ pid: process.pid, sessionFileArg: sessionArgIndex >= 0 ? args[sessionArgIndex + 1] : null }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index).replace(/\\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function state() { return { sessionId, sessionFile, sessionName: name, isStreaming: false, isCompacting: false, messageCount: 0, model: { provider: "fake", id: "model" } }; }
function handle(message) {
  if (message.type === "get_state") return send({ id: message.id, type: "response", command: "get_state", success: true, data: state() });
  if (message.type === "get_session_stats") return send({ id: message.id, type: "response", command: "get_session_stats", success: true, data: { tokens: { total: 0 }, cost: 0 } });
  if (message.type === "set_session_name") { name = String(message.name || ""); return send({ id: message.id, type: "response", command: "set_session_name", success: true }); }
  if (message.type === "get_messages") return send({ id: message.id, type: "response", command: "get_messages", success: true, data: { messages } });
  if (message.type === "prompt") {
    const now = Date.now();
    const user = { role: "user", timestamp: now, content: [{ type: "text", text: String(message.message || "") }] };
    const assistant = { role: "assistant", timestamp: now + 1, content: [{ type: "text", text: "fake rpc response to: " + message.message }] };
    messages.push(user, assistant);
    send({ id: message.id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    send({ type: "message_end", message: assistant });
    send({ type: "agent_end", messages: [user, assistant] });
    return;
  }
  send({ id: message.id, type: "response", command: message.type, success: true });
}
setInterval(() => {}, 60000);
`, "utf8");
  const executable = path.join(root, "fake-pi");
  await fsp.writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeRpc)} "$@"\n`, "utf8");
  await fsp.chmod(executable, 0o755);
  return { executable, startLog };
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function readStarts(file: string, expectedCount: number): Promise<unknown[]> {
  const deadline = Date.now() + 5_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await fsp.readFile(file, "utf8");
      const lines = last.trim().split(/\n+/).filter(Boolean);
      if (lines.length >= expectedCount) return lines.map((line) => JSON.parse(line));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}
