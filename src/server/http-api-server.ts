import http from "node:http";
import path from "node:path";
import os from "node:os";
import { MockPiAdapter } from "./pi/mock-pi-adapter.js";
import { SdkPiAdapter } from "./pi/sdk-pi-adapter.js";
import type { SessionMessage } from "./pi/types.js";
import { PathPolicy } from "./security/path-policy.js";
import { SessionRegistry } from "./session/session-registry.js";

const port = Number(process.env.PI_REMOTE_API_PORT ?? 8787);
const projectRoot = path.resolve(process.env.PI_REMOTE_PROJECT_ROOT ?? process.env.HOME ?? process.cwd());
const sessionRoot = path.resolve(process.env.PI_REMOTE_SESSION_ROOT ?? path.join(os.homedir(), ".pi", "agent", "sessions"));
const useMock = process.env.PI_REMOTE_USE_MOCK === "1";

const registry = new SessionRegistry({
  adapter: useMock ? new MockPiAdapter({ sessionRoot }) : new SdkPiAdapter({ sessionDir: sessionRoot }),
  pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
});

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`pi-remote-control API listening on http://127.0.0.1:${port}`);
  console.log(`adapter=${useMock ? "mock" : "pi-sdk"}`);
  console.log(`projectRoot=${projectRoot}`);
  console.log(`sessionRoot=${sessionRoot}`);
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") return sendJson(res, 204, undefined);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, adapter: useMock ? "mock" : "pi-sdk", projectRoot, sessionRoot });
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const sessions = await registry.listSessions(cwd);
    return sendJson(res, 200, sessions.map((session) => ({
      id: session.id,
      cwd: session.cwd,
      sessionName: session.sessionName,
      status: "idle",
      model: undefined,
      tokenSummary: undefined,
      lastActivity: Number.isFinite(session.lastActivity) ? session.lastActivity : Date.now(),
    })));
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req) as { cwd?: string; sessionName?: string };
    if (!body.cwd) return sendJson(res, 400, { error: "cwd is required" });
    const created = await registry.createSession({ cwd: body.cwd, ...(body.sessionName ? { sessionName: body.sessionName } : {}) });
    const state = await created.handle.getState();
    return sendJson(res, 200, toSessionCard(state));
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|prompt|bash|abort|rename|delete))?$/);
  if (!match) return sendJson(res, 404, { error: "not found" });
  const sessionId = decodeURIComponent(match[1]!);
  const action = match[2] ?? "state";

  if (req.method === "GET" && action === "messages") {
    const session = registry.getSession(sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "POST" && action === "prompt") {
    const body = await readJson(req) as { text?: string };
    if (!body.text) return sendJson(res, 400, { error: "text is required" });
    await registry.prompt(sessionId, body.text);
    const session = registry.getSession(sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "POST" && action === "bash") {
    const body = await readJson(req) as { command?: string; includeInContext?: boolean };
    if (!body.command) return sendJson(res, 400, { error: "command is required" });
    // Temporary compatibility path: until the adapter exposes Pi's bash RPC operation directly,
    // add bash as a user-visible message and follow with a prompt asking Pi to run it.
    await registry.prompt(sessionId, `${body.includeInContext === false ? "Run this hidden shell command for operator context only" : "Run this shell command and consider its output"}: ${body.command}`);
    const session = registry.getSession(sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "POST" && action === "abort") {
    await registry.abort(sessionId);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "rename") {
    // Rename is currently optimistic/UI-only until adapter exposes session info mutation.
    const session = registry.getSession(sessionId);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "POST" && action === "delete") {
    await registry.disposeSession(sessionId);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

function toSessionCard(state: Awaited<ReturnType<import("./pi/types.js").PiSessionHandle["getState"]>>) {
  return {
    id: state.id,
    cwd: state.cwd,
    sessionName: state.sessionName,
    status: state.status === "running" ? "streaming" : state.status,
    model: undefined,
    tokenSummary: `${state.messageCount} messages`,
    lastActivity: state.lastActivity,
  };
}

function toDashboardMessages(messages: readonly SessionMessage[]) {
  return messages.map((message, index) => ({
    id: `${message.timestamp}-${index}`,
    role: message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "custom",
    text: message.content,
    provider: message.role === "assistant" ? "pi" : undefined,
  }));
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  setCors(res);
  res.statusCode = status;
  if (status === 204) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}
