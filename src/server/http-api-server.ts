import http from "node:http";
import path from "node:path";
import os from "node:os";
import { MockPiAdapter } from "./pi/mock-pi-adapter.js";
import { SdkPiAdapter } from "./pi/sdk-pi-adapter.js";
import type { PromptAttachment, SessionMessage } from "./pi/types.js";
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
const coldSessionFiles = new Map<string, string>();

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

  if (req.method === "GET" && url.pathname === "/api/models") {
    return sendJson(res, 200, await registry.listModels());
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, adapter: useMock ? "mock" : "pi-sdk", projectRoot, sessionRoot, defaultCwd: process.cwd() });
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const sessions = await registry.listSessions(cwd);
    for (const session of sessions) coldSessionFiles.set(session.id, session.sessionFile);
    return sendJson(res, 200, sessions.map((session) => ({
      id: session.id,
      cwd: session.cwd,
      sessionFile: session.sessionFile,
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
    coldSessionFiles.set(created.id, created.sessionFile);
    return sendJson(res, 200, toSessionCard(state));
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|prompt|bash|abort|rename|delete|model|state|events))?$/);
  if (!match) return sendJson(res, 404, { error: "not found" });
  const sessionId = decodeURIComponent(match[1]!);
  const action = match[2] ?? "state";

  if (req.method === "GET" && action === "events") {
    const session = await getOrOpenSession(sessionId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);

    const unsubscribe = session.handle.subscribe((event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // socket closed; cleanup below
      }
    });

    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat\n\n`); } catch { /* socket closed */ }
    }, 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  if (req.method === "GET" && action === "messages") {
    const session = await getOrOpenSession(sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "GET" && (action === "state" || action === undefined)) {
    const session = await getOrOpenSession(sessionId);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "POST" && action === "prompt") {
    const body = await readJson(req) as { text?: string; attachments?: readonly PromptAttachment[] };
    if (!body.text) return sendJson(res, 400, { error: "text is required" });
    await getOrOpenSession(sessionId);
    await registry.prompt(sessionId, body.text, normalizePromptAttachments(body.attachments));
    const session = await getOrOpenSession(sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "POST" && action === "bash") {
    const body = await readJson(req) as { command?: string; includeInContext?: boolean };
    if (!body.command) return sendJson(res, 400, { error: "command is required" });
    // Temporary compatibility path: until the adapter exposes Pi's bash RPC operation directly,
    // add bash as a user-visible message and follow with a prompt asking Pi to run it.
    await getOrOpenSession(sessionId);
    await registry.prompt(sessionId, `${body.includeInContext === false ? "Run this hidden shell command for operator context only" : "Run this shell command and consider its output"}: ${body.command}`);
    const session = await getOrOpenSession(sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "POST" && action === "abort") {
    await getOrOpenSession(sessionId);
    await registry.abort(sessionId);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "rename") {
    const body = await readJson(req) as { name?: string };
    if (typeof body.name !== "string") return sendJson(res, 400, { error: "name is required" });
    const session = await getOrOpenSession(sessionId);
    await registry.setSessionName(sessionId, body.name);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "POST" && action === "model") {
    const body = await readJson(req) as { provider?: string; modelId?: string };
    if (!body.provider || !body.modelId) return sendJson(res, 400, { error: "provider and modelId are required" });
    const session = await getOrOpenSession(sessionId);
    await registry.setModel(sessionId, body.provider, body.modelId);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "POST" && action === "delete") {
    await registry.disposeSession(sessionId);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

async function getOrOpenSession(sessionId: string) {
  if (registry.hasSession(sessionId)) return registry.getSession(sessionId);
  const sessionFile = coldSessionFiles.get(sessionId);
  if (!sessionFile) throw new Error(`Unknown session: ${sessionId}`);
  return registry.openSession(sessionFile);
}

function toSessionCard(state: Awaited<ReturnType<import("./pi/types.js").PiSessionHandle["getState"]>>) {
  return {
    id: state.id,
    cwd: state.cwd,
    sessionName: state.sessionName,
    status: state.status === "running" ? "streaming" : state.status,
    model: state.modelProvider && state.model ? `${state.modelProvider}/${state.model}` : undefined,
    tokenSummary: state.totalTokens === undefined || state.totalTokens === null
      ? undefined
      : `${formatTokens(state.totalTokens)} tokens`,
    stats: state.stats,
    lastActivity: state.lastActivity,
  };
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function toDashboardMessages(messages: readonly SessionMessage[]) {
  return messages.map((message, index) => ({
    id: `${message.timestamp}-${index}`,
    role: message.role === "assistant"
      ? "assistant"
      : message.role === "user"
        ? "user"
        : message.role === "tool"
          ? "tool"
          : "custom",
    text: message.content,
    provider: message.role === "assistant" ? "pi" : undefined,
    tool: message.tool,
    timestamp: message.timestamp,
  }));
}

function normalizePromptAttachments(attachments: readonly PromptAttachment[] | undefined): readonly PromptAttachment[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((attachment) => attachment.type === "image" && typeof attachment.data === "string" && attachment.data.length > 0);
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
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
