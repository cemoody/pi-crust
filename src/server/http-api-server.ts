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
import type { PromptAttachment, SessionListItem, SessionMessage } from "./pi/types.js";
import { PathPolicy } from "./security/path-policy.js";
import { resolveGitSha, createLiveGitSha } from "./git-sha.js";
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
  /**
   * Where to append client-side telemetry events (one JSON line per event).
   * Used to investigate spurious browser refreshes. Omit to disable logging.
   */
  readonly clientEventLogPath?: string;
  /**
   * Short git SHA of the backend; surfaced on /api/health for the WUI's
   * help dialog. May be a string (frozen at startup, used by tests and
   * CI builds) or a getter (live, recomputed when .git/HEAD changes —
   * the default for `npm run dev:api`). When omitted the server falls
   * back to a live getter at request time so a stale value never lies
   * about the running build.
   */
  readonly gitSha?: string | (() => string);
}

interface HttpApiServerContext extends HttpApiServerOptions {
  readonly coldSessionFiles: Map<string, string>;
  /**
   * Maps a requested/cold id to the live id reported by the worker that opened
   * it. This can happen around fork/clone when an existing RPC worker has
   * switched identity but a stale URL/status row still references the old id.
   */
  readonly sessionAliases: Map<string, string>;
  readonly clientEventLog?: ClientEventLog;
  /**
   * Dedupes concurrent getOrOpenSession() calls for the same sessionId.
   * Without this, page-load races (initial GET + SSE subscribe) each call
   * openSession() before either has registered the result, spawning two
   * supervisors. The second adapter connection then evicts the first inside
   * the supervisor's onConnection handler, causing
   * "Supervisor connection closed before frame arrived" on the first.
   */
  readonly openingSessions: Map<string, Promise<import("./session/session-registry.js").RegisteredSession>>;
  /**
   * Active SSE streams keyed by `tabSessionId`. When a new SSE arrives for a
   * tab that already has one open, the previous one is closed so the browser
   * promptly frees the underlying TCP connection. Without this, leaked
   * streams (from session-switching, soft reloads, etc.) accumulate against
   * Chrome's 6-per-origin HTTP/1.1 connection budget and the next request
   * from the page stalls indefinitely.
   */
  readonly activeSseByTab: Map<string, http.ServerResponse>;
}

const CLIENT_EVENT_MAX_BYTES = 16 * 1024;

/** Append-only JSON-lines logger used for client telemetry. Lazy-creates the file. */
interface ClientEventLog {
  append(payload: Record<string, unknown>): Promise<void>;
}

function resolveContextGitSha(value: string | (() => string) | undefined): string {
  if (typeof value === "function") {
    try { return value(); } catch { return "unknown"; }
  }
  if (typeof value === "string" && value.trim()) return value;
  return "unknown";
}

function createClientEventLog(filePath: string): ClientEventLog {
  let queue: Promise<void> = Promise.resolve();
  return {
    append(payload) {
      queue = queue.then(async () => {
        try {
          await fsp.mkdir(path.dirname(filePath), { recursive: true });
          await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
        } catch (error) {
          console.warn(`client-event log append failed: ${error instanceof Error ? error.message : error}`);
        }
      });
      return queue;
    },
  };
}

export function createHttpApiServer(options: HttpApiServerOptions): http.Server {
  const context: HttpApiServerContext = {
    ...options,
    coldSessionFiles: new Map(),
    sessionAliases: new Map(),
    openingSessions: new Map(),
    activeSseByTab: new Map(),
    ...(options.clientEventLogPath ? { clientEventLog: createClientEventLog(options.clientEventLogPath) } : {}),
  };
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
  const clientEventLogPath = process.env.PI_REMOTE_CLIENT_EVENT_LOG
    ?? path.resolve(process.cwd(), "logs", "client-events.jsonl");
  // Live SHA: recomputed when .git/HEAD changes so /api/health doesn't lie
  // about the build after a `git pull` lands new commits.
  const gitSha = createLiveGitSha({ cwd: process.cwd(), env: process.env });
  const server = createHttpApiServer({
    registry,
    adapterKind,
    projectRoot,
    sessionRoot,
    defaultCwd: process.cwd(),
    cronStore,
    cronScheduler,
    clientEventLogPath,
    gitSha,
  });
  // Reattach any detached Pi RPC workers that survived a previous API process.
  try {
    const reattached = await registry.reattachAll();
    if (reattached.length > 0) console.log(`reattached ${reattached.length} detached session(s): ${reattached.join(", ")}`);
  } catch (err) {
    console.warn(`reattachAll failed: ${err instanceof Error ? err.message : err}`);
  }
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`pi-remote-control API: port ${port} on ${host} is already in use.`);
      console.error(`hint: find the holder with: lsof -ti :${port}    (or: ss -tlnp | grep ${port})`);
      // Exit cleanly so a supervisor loop can back off rather than crash-loop
      // on an unhandled 'error' event. Code 2 is the canonical "bad config"
      // exit code outer loops can react to.
      process.exit(2);
    }
    console.error(`pi-remote-control API: server error: ${error.message}`);
    process.exit(1);
  });
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
    // 8s budget (was 3s) to be defensive against many concurrent supervisors
    // taking slightly longer to FIN their sockets. Detach is parallel via
    // Promise.all and each socket close is bounded to 100ms, so in practice
    // detach completes in <1s even for 30+ live sessions — 8s is pure
    // headroom. Hitting this timeout is a bug worth investigating; the
    // process exits anyway so the supervisors aren't blocked indefinitely.
    const timer = setTimeout(() => { console.warn("detach timed out, exiting"); process.exit(0); }, 8000);
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
    return sendJson(res, 200, {
      ok: true,
      adapter: context.adapterKind,
      projectRoot: context.projectRoot,
      sessionRoot: context.sessionRoot,
      defaultCwd: context.defaultCwd ?? process.cwd(),
      // The user's home directory (server-side). The WUI uses this as the
      // default 'Working directory' in the New Session dialog, which is
      // friendlier than seeding it with whatever the API was invoked from.
      homeCwd: os.homedir(),
      gitSha: resolveContextGitSha(context.gitSha),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/client-event") {
    return handleClientEvent(req, res, context);
  }

  if (url.pathname.startsWith("/api/cron")) {
    return handleCron(req, res, url, context);
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    return sendJson(res, 200, await listSessionCards(context, cwd));
  }

  if (req.method === "GET" && url.pathname === "/api/sessions/statuses") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    return sendJson(res, 200, await listSessionCards(context, cwd));
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req) as { cwd?: string; sessionName?: string };
    if (!body.cwd) return sendJson(res, 400, { error: "cwd is required" });
    const created = await context.registry.createSession({ cwd: body.cwd, ...(body.sessionName ? { sessionName: body.sessionName } : {}) });
    const state = await created.handle.getState();
    context.coldSessionFiles.set(created.id, created.sessionFile);
    return sendJson(res, 200, toSessionCard(state));
  }

  // Static-UI fallback. When PI_REMOTE_UI_DIR is set (typically by the
  // `bin/pi-remote-control` launcher pointing at the built Vite output), any
  // GET that didn't match an /api route falls through to file serving so a
  // single process can host both the API and the WUI. SPA semantics: unknown
  // routes fall back to index.html so client-side routes Just Work.
  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const uiDir = process.env.PI_REMOTE_UI_DIR;
    if (uiDir) {
      const served = await tryServeStatic(uiDir, url.pathname, res);
      if (served) return;
    }
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
    // Evict any prior SSE for the same browser tab before sending headers.
    // The WUI passes its per-tab id (sessionStorage-scoped) as a query param;
    // see src/web/api/http-session-api.ts and the repro in
    // tests/playwright/sse-connection-pool.spec.ts.
    const tabSessionId = url.searchParams.get("tabSessionId");
    if (tabSessionId) {
      const previous = context.activeSseByTab.get(tabSessionId);
      if (previous && previous !== res && !previous.writableEnded) {
        try {
          previous.write(`event: evicted\ndata: ${JSON.stringify({ reason: "replaced-by-newer-stream" })}\n\n`);
        } catch { /* socket already gone */ }
        try { previous.end(); } catch { /* ignore */ }
      }
      context.activeSseByTab.set(tabSessionId, res);
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);

    // Telemetry: record the SSE lifecycle so we can correlate it with
    // client-reported boots and visibility changes. A fresh sse-open within
    // a few seconds of a previous sse-close is a strong signal of a tab
    // reload (vs. a clean route change which would have only one lifecycle).
    const sseOpenedAt = Date.now();
    void context.clientEventLog?.append({
      serverTs: sseOpenedAt,
      kind: "sse-open",
      sessionId,
      remoteAddress: req.socket.remoteAddress ?? null,
      ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      fromSeq: typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null,
    });

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
      // Only drop the active-stream entry if it's still us (the eviction path
      // above may have already replaced it with a newer response object).
      if (tabSessionId && context.activeSseByTab.get(tabSessionId) === res) {
        context.activeSseByTab.delete(tabSessionId);
      }
      void context.clientEventLog?.append({
        serverTs: Date.now(),
        kind: "sse-close",
        sessionId,
        lifetimeMs: Date.now() - sseOpenedAt,
        remoteAddress: req.socket.remoteAddress ?? null,
      });
    });
    return;
  }

  if (req.method === "GET" && action === "messages") {
    const session = await getOrOpenSession(context, sessionId);
    return sendJson(res, 200, toDashboardMessages(await session.handle.getMessages()));
  }

  if (req.method === "GET" && (action === "state" || action === undefined)) {
    const session = await getOrOpenSession(context, sessionId);
    const metadata = await readSessionTimelineMetadata(session.sessionFile);
    return sendJson(res, 200, toSessionCard(await session.handle.getState(), metadata));
  }

  if (req.method === "GET" && action === "fork-messages") {
    const session = await getOrOpenSession(context, sessionId);
    return sendJson(res, 200, await context.registry.getForkMessages(session.id));
  }

  if (req.method === "POST" && action === "fork") {
    const body = await readJson(req) as { entryId?: string };
    if (!body.entryId) return sendJson(res, 400, { error: "entryId is required" });
    const source = await getOrOpenSession(context, sessionId);
    const { result, session } = await context.registry.forkSession(source.id, body.entryId);
    context.coldSessionFiles.set(session.id, session.sessionFile);
    return sendJson(res, 200, { ...result, session: toSessionCard(await session.handle.getState()) });
  }

  if (req.method === "POST" && action === "clone") {
    const source = await getOrOpenSession(context, sessionId);
    const { result, session } = await context.registry.cloneSession(source.id);
    context.coldSessionFiles.set(session.id, session.sessionFile);
    return sendJson(res, 200, { ...result, session: toSessionCard(await session.handle.getState()) });
  }

  if (req.method === "POST" && action === "prompt") {
    const body = await readJson(req) as { text?: string; attachments?: readonly PromptAttachment[] };
    const text = body.text ?? "";
    const attachments = normalizePromptAttachments(body.attachments);
    if (!text && attachments.length === 0) return sendJson(res, 400, { error: "text or an attachment is required" });
    if (text.length > MAX_PROMPT_CHARS) {
      return sendJson(res, 413, { error: `Message is ${text.length} characters. The limit is ${MAX_PROMPT_CHARS}. If you meant to send an image, use the paperclip or paste the image into the composer.` });
    }
    const session = await getOrOpenSession(context, sessionId);
    const { promptText, modelAttachments } = await preparePromptAttachments(session.handle, text, attachments);
    await context.registry.prompt(session.id, promptText, modelAttachments);
    const updatedSession = await getOrOpenSession(context, session.id);
    return sendJson(res, 200, toDashboardMessages(await updatedSession.handle.getMessages()));
  }

  if (req.method === "POST" && action === "bash") {
    const body = await readJson(req) as { command?: string; includeInContext?: boolean };
    if (!body.command) return sendJson(res, 400, { error: "command is required" });
    // Temporary compatibility path: until the adapter exposes Pi's bash RPC operation directly,
    // add bash as a user-visible message and follow with a prompt asking Pi to run it.
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.prompt(session.id, `${body.includeInContext === false ? "Run this hidden shell command for operator context only" : "Run this shell command and consider its output"}: ${body.command}`);
    const updatedSession = await getOrOpenSession(context, session.id);
    return sendJson(res, 200, toDashboardMessages(await updatedSession.handle.getMessages()));
  }

  if (req.method === "POST" && action === "abort") {
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.abort(session.id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "rename") {
    const body = await readJson(req) as { name?: string };
    if (typeof body.name !== "string") return sendJson(res, 400, { error: "name is required" });
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.setSessionName(session.id, body.name);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "POST" && action === "model") {
    const body = await readJson(req) as { provider?: string; modelId?: string };
    if (!body.provider || !body.modelId) return sendJson(res, 400, { error: "provider and modelId are required" });
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.setModel(session.id, body.provider, body.modelId);
    return sendJson(res, 200, toSessionCard(await session.handle.getState()));
  }

  if (req.method === "POST" && action === "extension-ui-response") {
    const body = await readJson(req);
    const response = parseExtensionUiResponse(body);
    if (!response) return sendJson(res, 400, { error: "Invalid extension UI response" });
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.respondToExtensionUi(session.id, response);
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

async function handleClientEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: HttpApiServerContext,
): Promise<void> {
  // Collect the body up to CLIENT_EVENT_MAX_BYTES. Anything beyond gets 413.
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    received += buf.length;
    if (received > CLIENT_EVENT_MAX_BYTES) {
      return sendJson(res, 413, { error: "client-event payload too large" });
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return sendJson(res, 400, { error: "client-event payload was not JSON" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return sendJson(res, 400, { error: "client-event payload must be a JSON object" });
  }

  // Stamp every entry with server-side context the client can't fake.
  const enriched = {
    serverTs: Date.now(),
    remoteAddress: req.socket.remoteAddress ?? null,
    ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    ...(parsed as Record<string, unknown>),
  };
  await context.clientEventLog?.append(enriched);
  return sendJson(res, 204, undefined);
}

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
  const resolvedId = resolveSessionAlias(context, sessionId);
  if (context.registry.hasSession(resolvedId)) return context.registry.getSession(resolvedId);
  if (resolvedId !== sessionId && context.registry.hasSession(sessionId)) return context.registry.getSession(sessionId);
  // De-duplicate concurrent opens for the same sessionId. See the
  // openingSessions docstring on HttpApiServerContext for why.
  const inflight = context.openingSessions.get(sessionId);
  if (inflight) return inflight;
  const sessionFile = context.coldSessionFiles.get(sessionId) ?? context.coldSessionFiles.get(resolvedId);
  if (!sessionFile) throw new Error(`Unknown session: ${sessionId}`);
  const pending = context.registry.openSession(sessionFile)
    .then((session) => {
      context.coldSessionFiles.set(session.id, session.sessionFile);
      if (session.id !== sessionId) context.sessionAliases.set(sessionId, session.id);
      return session;
    })
    .finally(() => { context.openingSessions.delete(sessionId); });
  context.openingSessions.set(sessionId, pending);
  return pending;
}

function resolveSessionAlias(context: HttpApiServerContext, sessionId: string): string {
  let current = sessionId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = context.sessionAliases.get(current);
    if (!next) return current;
    current = next;
  }
  return current;
}

async function listSessionCards(context: HttpApiServerContext, cwd?: string) {
  const sessions = await context.registry.listSessions(cwd);
  for (const session of sessions) context.coldSessionFiles.set(session.id, session.sessionFile);
  return Promise.all(sessions.map((session) => sessionCardWithLiveState(context, session)));
}

async function sessionCardWithLiveState(context: HttpApiServerContext, session: SessionListItem) {
  const metadata = await readSessionTimelineMetadata(session.sessionFile);
  if (context.registry.hasSession(session.id)) {
    try {
      const card = toSessionCard(await context.registry.getSession(session.id).handle.getState(), metadata);
      return {
        ...card,
        // getState() is an observation and some adapters report Date.now()
        // there. Sidebar snapshots should sort by real session activity from
        // the session index, not by the time this polling request ran.
        lastActivity: Number.isFinite(session.lastActivity) ? session.lastActivity : card.lastActivity,
      };
    } catch {
      // Fall back to the persisted list entry if the hot handle disappeared
      // while this status snapshot was being assembled.
    }
  }
  return toSessionListCard(session, metadata);
}

interface SessionTimelineMetadata {
  readonly createdAt: number | null;
  readonly lastUserActivity: number | null;
}

interface CachedSessionTimelineMetadata {
  readonly mtimeMs: number;
  readonly size: number;
  readonly metadata: SessionTimelineMetadata;
}

const sessionTimelineMetadataCache = new Map<string, CachedSessionTimelineMetadata>();

async function readSessionTimelineMetadata(sessionFile: string): Promise<SessionTimelineMetadata> {
  let createdAt: number | null = null;
  let lastUserActivity: number | null = null;
  if (!sessionFile) return { createdAt, lastUserActivity };
  try {
    const stat = await fsp.stat(sessionFile);
    const cached = sessionTimelineMetadataCache.get(sessionFile);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.metadata;
    const content = await fsp.readFile(sessionFile, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!isRecord(entry)) continue;
      if (entry.type === "session" && createdAt === null) {
        createdAt = coerceTime(entry.timestamp);
        continue;
      }
      if (entry.type !== "message" || !isRecord(entry.message)) continue;
      if (entry.message.role !== "user") continue;
      const timestamp = coerceTime(entry.message.timestamp) ?? coerceTime(entry.timestamp);
      if (timestamp === null) continue;
      lastUserActivity = Math.max(lastUserActivity ?? 0, timestamp);
    }
    const metadata = { createdAt, lastUserActivity };
    sessionTimelineMetadataCache.set(sessionFile, { mtimeMs: stat.mtimeMs, size: stat.size, metadata });
    return metadata;
  } catch {
    // Missing/unreadable historical session files degrade to null metadata.
  }
  return { createdAt, lastUserActivity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coerceTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "string" && value.trim()) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function toSessionListCard(session: SessionListItem, metadata: SessionTimelineMetadata = { createdAt: null, lastUserActivity: null }) {
  return {
    id: session.id,
    cwd: session.cwd,
    sessionFile: session.sessionFile,
    sessionName: session.sessionName,
    status: "idle",
    model: undefined,
    tokenSummary: undefined,
    createdAt: metadata.createdAt ?? session.createdAt ?? null,
    lastUserActivity: metadata.lastUserActivity ?? session.lastUserActivity ?? null,
    lastActivity: Number.isFinite(session.lastActivity) ? session.lastActivity : (metadata.lastUserActivity ?? metadata.createdAt ?? 0),
  };
}

function toSessionCard(state: Awaited<ReturnType<import("./pi/types.js").PiSessionHandle["getState"]>>, metadata: SessionTimelineMetadata = { createdAt: null, lastUserActivity: null }) {
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
    createdAt: metadata.createdAt ?? state.createdAt ?? null,
    lastUserActivity: metadata.lastUserActivity ?? state.lastUserActivity ?? null,
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
    ...(message.thinking ? { thinking: message.thinking } : {}),
  }));
}

function normalizePromptAttachments(attachments: readonly PromptAttachment[] | undefined): readonly PromptAttachment[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((attachment) => {
    if (!attachment || typeof attachment !== "object") return false;
    if (attachment.type === "image") return typeof attachment.data === "string" && attachment.data.length > 0;
    if (attachment.type === "file") return typeof attachment.data === "string";
    return false;
  });
}

async function preparePromptAttachments(
  session: import("./pi/types.js").PiSessionHandle,
  text: string,
  attachments: readonly PromptAttachment[],
): Promise<{ promptText: string; modelAttachments: readonly PromptAttachment[] }> {
  const modelAttachments = attachments.filter((attachment) => attachment.type === "image");
  const fileAttachments = attachments.filter((attachment) => attachment.type === "file");
  if (fileAttachments.length === 0) return { promptText: text, modelAttachments };

  const state = await session.getState();
  const cwd = state.cwd;
  if (typeof cwd !== "string" || !cwd) throw new Error("Could not save attached file: session has no working directory");

  const savedFiles: string[] = [];
  const attachmentDir = path.resolve(cwd, ".pi", "attachments", session.id);
  try {
    await fsp.mkdir(attachmentDir, { recursive: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not save attached file: ${detail}`);
  }
  for (const [index, attachment] of fileAttachments.entries()) {
    const fileName = uniqueAttachmentFileName(attachment.name, index);
    const filePath = path.resolve(attachmentDir, fileName);
    if (path.dirname(filePath) !== attachmentDir) throw new Error(`Could not save attached file ${attachment.name ?? "attachment"}: invalid file name`);
    const bytes = base64AttachmentBytes(attachment.data ?? "", attachment.name);
    try {
      await fsp.writeFile(filePath, bytes, { flag: "wx" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not save attached file ${attachment.name ?? fileName}: ${detail}`);
    }
    savedFiles.push(filePath);
  }

  return { promptText: appendAttachedFileNotice(text, savedFiles), modelAttachments };
}

function appendAttachedFileNotice(text: string, files: readonly string[]): string {
  if (files.length === 0) return text;
  const notice = files.length === 1
    ? `The user attached a file and it has been saved locally at: ${files[0]}`
    : `The user attached ${files.length} files and they have been saved locally at:\n${files.map((file) => `- ${file}`).join("\n")}`;
  return text ? `${text}\n\n${notice}` : notice;
}

function uniqueAttachmentFileName(name: string | undefined, index: number): string {
  const safeName = sanitizeAttachmentFileName(name);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${index + 1}-${safeName}`;
}

function sanitizeAttachmentFileName(name: string | undefined): string {
  const base = path.basename(String(name ?? "attachment")).replace(/[\0/\\]/g, "");
  const safe = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+$/, "").trim();
  return (safe || "attachment").slice(0, 160);
}

function base64AttachmentBytes(data: string, name: string | undefined): Buffer {
  const compact = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error(`Could not save attached file ${name ?? "attachment"}: attachment data was not valid base64`);
  }
  return Buffer.from(compact, "base64");
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

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};

async function tryServeStatic(rootDir: string, pathname: string, res: http.ServerResponse): Promise<boolean> {
  const absRoot = path.resolve(rootDir);
  const rel = path.posix.normalize(pathname).replace(/^\/+/, "");
  let candidate = path.resolve(absRoot, rel);
  if (!candidate.startsWith(absRoot)) return false;
  let stat: fs.Stats | null = null;
  try { stat = await fsp.stat(candidate); } catch { stat = null; }
  if (stat && stat.isDirectory()) {
    candidate = path.join(candidate, "index.html");
    try { stat = await fsp.stat(candidate); } catch { stat = null; }
  }
  if (!stat || !stat.isFile()) {
    // SPA fallback for unknown routes — but only if the request didn't look
    // like an asset (so a missing .js / .css still 404s cleanly).
    if (/\.[a-z0-9]{2,5}$/i.test(pathname)) return false;
    candidate = path.join(absRoot, "index.html");
    try { stat = await fsp.stat(candidate); } catch { return false; }
    if (!stat.isFile()) return false;
  }
  const ext = path.extname(candidate).toLowerCase();
  const mime = STATIC_MIME[ext] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", String(stat.size));
  if (candidate.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
  else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(candidate);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
  return true;
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
