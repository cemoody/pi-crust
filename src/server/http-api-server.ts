import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MockPiAdapter } from "./pi/mock-pi-adapter.js";
import { SdkPiAdapter } from "./pi/sdk-pi-adapter.js";
import { PiRpcAdapter } from "./pi/pirpc-pi-adapter.js";
import { MAX_PROMPT_CHARS } from "../shared/limits.js";
import type { ExtensionUiResponse } from "../shared/protocol.js";
import type { PromptAttachment, SessionMessage } from "./pi/types.js";
import { PathPolicy } from "./security/path-policy.js";
import { SessionRegistry } from "./session/session-registry.js";
import { CronStore, type CronJob } from "./cron/cron-store.js";
import { CronScheduler } from "./cron/cron-scheduler.js";
import { parseCron, CronParseError, nextRun as cronNextRun } from "./cron/cron-expression.js";
import { WorkerRegistry } from "./session/worker-registry.js";

export interface HttpApiServerOptions {
  readonly registry: SessionRegistry;
  readonly adapterKind: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly defaultCwd?: string;
  readonly cronStore?: CronStore;
  readonly cronScheduler?: CronScheduler;
}

interface HttpApiServerContext extends HttpApiServerOptions {
  readonly coldSessionFiles: Map<string, string>;
}

export function createHttpApiServer(options: HttpApiServerOptions): http.Server {
  const context: HttpApiServerContext = { ...options, coldSessionFiles: new Map() };
  return http.createServer((req, res) => {
    void handle(req, res, context).catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
}

function createDefaultRegistry(adapterKind: string, sessionRoot: string, projectRoot: string): SessionRegistry {
  const workerRegistry = new WorkerRegistry();
  return new SessionRegistry({
    adapter: adapterKind === "mock"
      ? new MockPiAdapter({ sessionRoot })
      : adapterKind === "pirpc"
        ? new PiRpcAdapter({ sessionDir: sessionRoot, runtimeDir: workerRegistry.runtimeDir })
        : new SdkPiAdapter({ sessionDir: sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    workerRegistry,
  });
}

async function startDefaultServer(): Promise<void> {
  const port = Number(process.env.PI_REMOTE_API_PORT ?? 8787);
  const host = process.env.PI_REMOTE_API_HOST ?? "127.0.0.1";
  const projectRoot = path.resolve(process.env.PI_REMOTE_PROJECT_ROOT ?? process.env.HOME ?? process.cwd());
  const sessionRoot = path.resolve(process.env.PI_REMOTE_SESSION_ROOT ?? path.join(os.homedir(), ".pi", "agent", "sessions"));
  const adapterKind = process.env.PI_REMOTE_USE_MOCK === "1"
    ? "mock"
    : process.env.PI_REMOTE_ADAPTER === "pi-sdk"
      ? "pi-sdk"
      : "pirpc";
  const registry = createDefaultRegistry(adapterKind, sessionRoot, projectRoot);
  const cronFile = path.resolve(process.env.PI_REMOTE_CRON_FILE ?? path.join(os.homedir(), ".pi", "agent", "cron-jobs.json"));
  const cronStore = new CronStore(cronFile);
  const cronScheduler = new CronScheduler({ store: cronStore, registry });
  void cronScheduler.start().catch((error) => console.error("[cron] failed to start scheduler", error));
  const server = createHttpApiServer({
    registry,
    adapterKind,
    projectRoot,
    sessionRoot,
    defaultCwd: process.cwd(),
    cronStore,
    cronScheduler,
  });
  // Reattach any detached Pi RPC workers that survived a previous API process.
  try {
    const reattached = await registry.reattachAll();
    if (reattached.length > 0) console.log(`reattached ${reattached.length} detached session(s): ${reattached.join(", ")}`);
  } catch (err) {
    console.warn(`reattachAll failed: ${err instanceof Error ? err.message : err}`);
  }
  server.listen(port, host, () => {
    console.log(`pi-remote-control API listening on http://${host}:${port}`);
    console.log(`adapter=${adapterKind}`);
    console.log(`projectRoot=${projectRoot}`);
    console.log(`sessionRoot=${sessionRoot}`);
  });

  // On API shutdown, detach (don't kill) detached workers so sessions survive.
  let shuttingDown = false;
  const detachAndExit = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, detaching workers...`);
    const timer = setTimeout(() => { console.warn("detach timed out, exiting"); process.exit(0); }, 3000);
    timer.unref();
    void Promise.resolve()
      .then(() => registry.detachAll())
      .catch(() => undefined)
      .then(() => new Promise<void>((resolve) => server.close(() => resolve())))
      .catch(() => undefined)
      .then(() => { clearTimeout(timer); process.exit(0); });
  };
  process.on("SIGTERM", () => detachAndExit("SIGTERM"));
  process.on("SIGINT", () => detachAndExit("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startDefaultServer();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, context: HttpApiServerContext): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") return sendJson(res, 204, undefined);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/models") {
    return sendJson(res, 200, await context.registry.listModels());
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, adapter: context.adapterKind, projectRoot: context.projectRoot, sessionRoot: context.sessionRoot, defaultCwd: context.defaultCwd ?? process.cwd() });
  }

  if (url.pathname.startsWith("/api/cron")) {
    return handleCron(req, res, url, context);
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const sessions = await context.registry.listSessions(cwd);
    for (const session of sessions) context.coldSessionFiles.set(session.id, session.sessionFile);
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
    const created = await context.registry.createSession({ cwd: body.cwd, ...(body.sessionName ? { sessionName: body.sessionName } : {}) });
    const state = await created.handle.getState();
    context.coldSessionFiles.set(created.id, created.sessionFile);
    return sendJson(res, 200, toSessionCard(state));
  }

  // Artifact files live at <session.cwd>/.pi/artifacts/<sessionId>/<file>.
  // Served by GET /api/sessions/:sessionId/artifacts/:file (no traversal,
  // single file segment only) so the @cemoody/pi-artifact extension's
  // image/HTML representations resolve in the browser.
  const artifactMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)$/);
  if (req.method === "GET" && artifactMatch) {
    return handleArtifact(req, res, context, decodeURIComponent(artifactMatch[1]!), decodeURIComponent(artifactMatch[2]!));
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|prompt|bash|abort|rename|delete|model|state|events|extension-ui-response|fork-messages|fork|clone))?$/);
  if (!match) return sendJson(res, 404, { error: "not found" });
  const sessionId = decodeURIComponent(match[1]!);
  const action = match[2] ?? "state";

  if (req.method === "GET" && action === "events") {
    const session = await getOrOpenSession(context, sessionId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);

    // Honor Last-Event-ID for SSE resume so events emitted while the API
    // was down (and now sitting in the registry's per-session ring) are
    // replayed when the WUI reconnects.
    const lastEventHeader = req.headers["last-event-id"];
    const lastEventId = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
    const fromSeq = lastEventId && /^-?\d+$/.test(lastEventId) ? Number(lastEventId) : null;

    const writeEvent = (event: unknown, seq: number) => {
      try {
        const data = JSON.stringify(event);
        // session_resync gets its own named event type so the WUI can refetch
        // state without having to inspect every default-message payload.
        const isResync = typeof event === "object" && event !== null && (event as { type?: unknown }).type === "session_resync";
        if (isResync) {
          res.write(`id: ${seq}\nevent: session_resync\ndata: ${data}\n\n`);
        } else {
          res.write(`id: ${seq}\ndata: ${data}\n\n`);
        }
      } catch {
        // socket closed; cleanup below
      }
    };

    const unsubscribe = context.registry.subscribeFromSeq(session.id, fromSeq, writeEvent);

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
    const session = await getOrOpenSession(context, sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "GET" && (action === "state" || action === undefined)) {
    const session = await getOrOpenSession(context, sessionId);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "GET" && action === "fork-messages") {
    await getOrOpenSession(context, sessionId);
    return sendJson(res, 200, await context.registry.getForkMessages(sessionId));
  }

  if (req.method === "POST" && action === "fork") {
    const body = await readJson(req) as { entryId?: string };
    if (!body.entryId) return sendJson(res, 400, { error: "entryId is required" });
    await getOrOpenSession(context, sessionId);
    const { result, session } = await context.registry.forkSession(sessionId, body.entryId);
    context.coldSessionFiles.set(session.id, session.sessionFile);
    return sendJson(res, 200, { ...result, session: toSessionCard(await session.handle.getState()) });
  }

  if (req.method === "POST" && action === "clone") {
    await getOrOpenSession(context, sessionId);
    const { result, session } = await context.registry.cloneSession(sessionId);
    context.coldSessionFiles.set(session.id, session.sessionFile);
    return sendJson(res, 200, { ...result, session: toSessionCard(await session.handle.getState()) });
  }

  if (req.method === "POST" && action === "prompt") {
    const body = await readJson(req) as { text?: string; attachments?: readonly PromptAttachment[] };
    const text = body.text ?? "";
    const attachments = normalizePromptAttachments(body.attachments);
    if (!text && attachments.length === 0) return sendJson(res, 400, { error: "text or an image attachment is required" });
    if (text.length > MAX_PROMPT_CHARS) {
      return sendJson(res, 413, { error: `Message is ${text.length} characters. The limit is ${MAX_PROMPT_CHARS}. If you meant to send an image, use the paperclip or paste the image into the composer.` });
    }
    await getOrOpenSession(context, sessionId);
    await context.registry.prompt(sessionId, text, attachments);
    const session = await getOrOpenSession(context, sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "POST" && action === "bash") {
    const body = await readJson(req) as { command?: string; includeInContext?: boolean };
    if (!body.command) return sendJson(res, 400, { error: "command is required" });
    // Temporary compatibility path: until the adapter exposes Pi's bash RPC operation directly,
    // add bash as a user-visible message and follow with a prompt asking Pi to run it.
    await getOrOpenSession(context, sessionId);
    await context.registry.prompt(sessionId, `${body.includeInContext === false ? "Run this hidden shell command for operator context only" : "Run this shell command and consider its output"}: ${body.command}`);
    const session = await getOrOpenSession(context, sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "POST" && action === "abort") {
    await getOrOpenSession(context, sessionId);
    await context.registry.abort(sessionId);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "rename") {
    const body = await readJson(req) as { name?: string };
    if (typeof body.name !== "string") return sendJson(res, 400, { error: "name is required" });
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.setSessionName(sessionId, body.name);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "POST" && action === "model") {
    const body = await readJson(req) as { provider?: string; modelId?: string };
    if (!body.provider || !body.modelId) return sendJson(res, 400, { error: "provider and modelId are required" });
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.setModel(sessionId, body.provider, body.modelId);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "POST" && action === "extension-ui-response") {
    const body = await readJson(req);
    const response = parseExtensionUiResponse(body);
    if (!response) return sendJson(res, 400, { error: "Invalid extension UI response" });
    await getOrOpenSession(context, sessionId);
    await context.registry.respondToExtensionUi(sessionId, response);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "delete") {
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.deleteSession(session.id);
    context.coldSessionFiles.delete(session.id);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

const ARTIFACT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

async function handleArtifact(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  context: HttpApiServerContext,
  sessionId: string,
  file: string,
): Promise<void> {
  setCors(res);
  // Defense in depth: filename must be a single segment with no traversal.
  if (file.includes("/") || file.includes("\\") || file === "." || file === ".." || file.includes("\0")) {
    return sendJson(res, 400, { error: "invalid artifact filename" });
  }
  // The @cemoody/pi-artifact extension uses the full session-file ID
  // ("<iso-timestamp>_<uuid>") in its emitted artifact URLs, but the session
  // registry indexes sessions by the bare UUID. Accept both forms so the
  // browser can fetch /api/sessions/<full-id>/artifacts/<file> directly.
  const registryId = (() => {
    if (context.registry.hasSession(sessionId)) return sessionId;
    const underscoreIdx = sessionId.lastIndexOf("_");
    if (underscoreIdx >= 0) {
      const tail = sessionId.slice(underscoreIdx + 1);
      if (context.registry.hasSession(tail) || context.coldSessionFiles.has(tail)) return tail;
    }
    return sessionId;
  })();
  let session;
  try {
    session = await getOrOpenSession(context, registryId);
  } catch (error) {
    return sendJson(res, 404, { error: error instanceof Error ? error.message : "unknown session" });
  }
  const state = await session.handle.getState();
  const cwd = state.cwd;
  if (typeof cwd !== "string" || !cwd) return sendJson(res, 500, { error: "session has no cwd" });
  // The on-disk artifact directory uses the *URL's* sessionId, which matches
  // what the extension wrote when it created the file.
  const artifactsDir = path.resolve(cwd, ".pi/artifacts", sessionId);
  const filePath = path.resolve(artifactsDir, file);
  // Ensure the resolved path is still inside the per-session artifacts dir.
  if (filePath !== path.join(artifactsDir, file)) {
    return sendJson(res, 400, { error: "path escape rejected" });
  }
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendJson(res, 404, { error: "artifact not found" });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: "not a file" });
  const ext = path.extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", ARTIFACT_MIME[ext] ?? "application/octet-stream");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "private, max-age=300");
  fs.createReadStream(filePath).pipe(res);
}

async function getOrOpenSession(context: HttpApiServerContext, sessionId: string) {
  if (context.registry.hasSession(sessionId)) return context.registry.getSession(sessionId);
  const sessionFile = context.coldSessionFiles.get(sessionId);
  if (!sessionFile) throw new Error(`Unknown session: ${sessionId}`);
  return context.registry.openSession(sessionFile);
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

export function toDashboardMessages(messages: readonly SessionMessage[]) {
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
    images: message.images,
    timestamp: message.timestamp,
    ...(message.customType ? { customType: message.customType } : {}),
    ...(message.details ? { details: message.details } : {}),
    ...(message.stopReason ? { stopReason: message.stopReason } : {}),
    ...(message.errorMessage ? { error: message.errorMessage } : {}),
  }));
}

function normalizePromptAttachments(attachments: readonly PromptAttachment[] | undefined): readonly PromptAttachment[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((attachment) => attachment.type === "image" && typeof attachment.data === "string" && attachment.data.length > 0);
}

function parseExtensionUiResponse(value: unknown): ExtensionUiResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (typeof body.id !== "string" || !body.id) return undefined;
  if (typeof body.value === "string") return { id: body.id, value: body.value };
  if (typeof body.confirmed === "boolean") return { id: body.id, confirmed: body.confirmed };
  if (body.cancelled === true) return { id: body.id, cancelled: true };
  return undefined;
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

async function handleCron(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: HttpApiServerContext): Promise<void> {
  const store = context.cronStore;
  const scheduler = context.cronScheduler;
  if (!store || !scheduler) return sendJson(res, 503, { error: "cron not configured" });

  if (req.method === "GET" && url.pathname === "/api/cron") {
    const jobs = await store.list();
    return sendJson(res, 200, { jobs: jobs.map(toCronJobView), filePath: store.filePath });
  }

  if (req.method === "POST" && url.pathname === "/api/cron") {
    const body = await readJson(req) as { name?: string; schedule?: string; prompt?: string; cwd?: string; enabled?: boolean };
    const validation = validateCronInput(body);
    if (validation) return sendJson(res, 400, { error: validation });
    const job = await store.create({
      name: body.name!.trim(),
      schedule: body.schedule!.trim(),
      prompt: body.prompt ?? "",
      cwd: body.cwd!,
      enabled: body.enabled !== false,
    });
    // Compute first nextRun.
    try {
      const parsed = parseCron(job.schedule);
      const n = cronNextRun(parsed, new Date());
      if (n) await store.update(job.id, { nextRun: n.getTime() });
    } catch { /* ignored */ }
    const fresh = (await store.get(job.id))!;
    return sendJson(res, 200, toCronJobView(fresh));
  }

  const jobMatch = url.pathname.match(/^\/api\/cron\/([^/]+)(?:\/(run|delete))?$/);
  if (!jobMatch) return sendJson(res, 404, { error: "not found" });
  const jobId = decodeURIComponent(jobMatch[1]!);
  const action = jobMatch[2];

  if (req.method === "POST" && action === "delete") {
    const ok = await store.delete(jobId);
    if (!ok) return sendJson(res, 404, { error: "cron job not found" });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "run") {
    try {
      const result = await scheduler.runJobNow(jobId);
      const fresh = (await store.get(jobId))!;
      return sendJson(res, 200, { job: toCronJobView(fresh), sessionId: result.sessionId, sessionFile: result.sessionFile });
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (req.method === "POST" && !action) {
    const body = await readJson(req) as { name?: string; schedule?: string; prompt?: string; cwd?: string; enabled?: boolean };
    if (body.schedule !== undefined) {
      try { parseCron(body.schedule); } catch (error) {
        return sendJson(res, 400, { error: error instanceof CronParseError ? `Invalid schedule: ${error.message}` : "Invalid schedule" });
      }
    }
    const updated = await store.update(jobId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    });
    if (!updated) return sendJson(res, 404, { error: "cron job not found" });
    // Recompute nextRun on schedule/enabled change.
    if (body.schedule !== undefined || body.enabled !== undefined) {
      if (updated.enabled) {
        try {
          const parsed = parseCron(updated.schedule);
          const n = cronNextRun(parsed, new Date());
          if (n) await store.update(jobId, { nextRun: n.getTime() });
        } catch { /* ignored */ }
      }
    }
    const fresh = (await store.get(jobId))!;
    return sendJson(res, 200, toCronJobView(fresh));
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

function toCronJobView(job: CronJob) {
  let scheduleError: string | undefined;
  try { parseCron(job.schedule); } catch (error) {
    scheduleError = error instanceof Error ? error.message : String(error);
  }
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt,
    cwd: job.cwd,
    enabled: job.enabled,
    lastRun: job.lastRun ?? null,
    nextRun: job.nextRun ?? null,
    lastSessionId: job.lastSessionId ?? null,
    scheduleError: scheduleError ?? null,
  };
}

function validateCronInput(body: { name?: string; schedule?: string; cwd?: string }): string | null {
  if (!body.name || !body.name.trim()) return "name is required";
  if (!body.schedule || !body.schedule.trim()) return "schedule is required";
  if (!body.cwd || !body.cwd.trim()) return "cwd is required";
  try { parseCron(body.schedule); } catch (error) {
    return error instanceof CronParseError ? `Invalid schedule: ${error.message}` : "Invalid schedule";
  }
  return null;
}
