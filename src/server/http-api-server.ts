import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { MockPiAdapter } from "./pi/mock-pi-adapter.js";
import { SdkPiAdapter } from "./pi/sdk-pi-adapter.js";
import { contentTextAndThinking, PiRpcAdapter, toSessionMessages } from "./pi/pirpc-pi-adapter.js";
import { MAX_PROMPT_CHARS } from "../shared/limits.js";
import type { ExtensionUiResponse } from "../shared/protocol.js";
import type { PromptAttachment, SessionListItem, SessionMessage } from "./pi/types.js";
import { PathPolicy, isPathWithinRoot } from "./security/path-policy.js";
import { resolveGitSha, createLiveGitSha } from "./git-sha.js";
import { SessionRegistry } from "./session/session-registry.js";
import { WorkerRegistry } from "./session/worker-registry.js";
import type { PrcExtensionHost } from "../extensions/registry.js";
import { defaultPrcConfigDir } from "../extensions/bootstrap.js";
import { serializeExtensions } from "../extensions/metadata.js";
import { installExtensionPackage, readPrcSettings, removeExtensionPackage, setExtensionEnabled, writePrcSettings, type PrcAppBrandingSettings, type PrcSettings } from "../extensions/packages.js";
import { createPrcExtensionRuntime, type PrcExtensionRuntime } from "../extensions/runtime.js";
import { defaultArtifactFileRoots, resolveArtifactFile, streamArtifactFile } from "./artifact-file.js";
import { coerceTimestamp, isRecord } from "../shared/util.js";
import { lookupSessionMessage } from "./http-api-message-lookup.js";

export interface HttpApiServerOptions {
  readonly registry: SessionRegistry;
  readonly adapterKind: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly defaultCwd?: string;
  /**
   * Where to append client-side telemetry events (one JSON line per event).
   * Used to investigate spurious browser refreshes. Omit to disable logging.
   */
  readonly clientEventLogPath?: string;
  /**
   * Short git SHA of the backend; surfaced on /api/health for the pi-crust's
   * help dialog. May be a string (frozen at startup, used by tests and
   * CI builds) or a getter (live, recomputed when .git/HEAD changes —
   * the default for `npm run dev:api`). When omitted the server falls
   * back to a live getter at request time so a stale value never lies
   * about the running build.
   */
  readonly gitSha?: string | (() => string);
  /** Test-first seed for pi-crust server extensions. Extension routes are mounted
   * under /api/extensions/:extensionId/* and are intentionally passed in by
   * tests/harnesses until package discovery is wired into the default server.
   */
  readonly extensions?: PrcExtensionHost;
  readonly extensionRuntime?: PrcExtensionRuntime;
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

/**
 * Append-only JSON-lines logger used for client telemetry. Lazy-creates the
 * file. Also maintains an in-memory rolling ring of the most recent events
 * so /api/client-event/stats can answer "what's been happening in the last
 * 5 minutes?" without re-reading the (potentially huge) jsonl from disk.
 *
 * The ring is purely additive observability — it never replaces or alters
 * the on-disk log, and a full ring drops the OLDEST events (so the most
 * recent N are always available for the stats query the dashboard polls).
 */
interface ClientEventLog {
  append(payload: Record<string, unknown>): Promise<void>;
  stats(windowMs: number): ClientEventStats;
}

export interface ClientEventStats {
  /** The window the stats were computed over, in ms. */
  windowMs: number;
  /** Total events in window. */
  total: number;
  /** Number of events the in-memory ring has dropped due to capacity. */
  bufferDropped: number;
  /** Histogram of event 'kind' values. */
  byKind: Record<string, number>;
  /** Histogram of status codes for 'api-error' events (PR-B). */
  byApiErrorStatus: Record<string, number>;
  /** Top 5 sessionIds by event count (a single very-broken session is a leading indicator). */
  topSessions: Array<{ sessionId: string; count: number }>;
  /** Top 5 api-error paths by count. */
  topApiErrorPaths: Array<{ path: string; count: number }>;
}

// Max events kept in memory for /stats. ~5 KB per event * 4096 = ~20 MB max.
// More than enough for a 5-minute window on a busy box; older events fall off
// into the on-disk jsonl which remains the source of truth for deep dives.
export const CLIENT_EVENT_RING_CAPACITY = 4096;

function resolveContextGitSha(value: string | (() => string) | undefined): string {
  if (typeof value === "function") {
    try { return value(); } catch { return "unknown"; }
  }
  if (typeof value === "string" && value.trim()) return value;
  return "unknown";
}

function resolveEnvAppBranding(env: NodeJS.ProcessEnv): { readonly appName: string; readonly appIcon?: string } {
  const appName = env.PI_CRUST_APP_NAME?.trim() || "π crust";
  const appIcon = env.PI_CRUST_APP_ICON?.trim();
  return { appName, ...(appIcon ? { appIcon } : {}) };
}

async function resolveAppBranding(context: Pick<HttpApiServerContext, "extensionRuntime">): Promise<{ readonly appName: string; readonly appIcon?: string }> {
  const env = resolveEnvAppBranding(process.env);
  if (!context.extensionRuntime) return env;
  const settings = await readPrcSettings(context.extensionRuntime.configDir);
  return effectiveAppBranding(settings.appBranding, env);
}

function applyDottedSetting<T extends Record<string, unknown>>(base: T, key: string, value: unknown): Record<string, unknown> {
  const segments = key.split(".");
  // Deep-clone the relevant slice and assign at the leaf.
  const next: Record<string, unknown> = { ...base };
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const child = cursor[segment];
    const cloned: Record<string, unknown> = (child && typeof child === "object" && !Array.isArray(child))
      ? { ...(child as Record<string, unknown>) }
      : {};
    cursor[segment] = cloned;
    cursor = cloned;
  }
  const leaf = segments[segments.length - 1]!;
  if (value === undefined || value === null || value === "") {
    delete cursor[leaf];
  } else {
    cursor[leaf] = value;
  }
  return next;
}

export { applyDottedSetting };

function effectiveAppBranding(
  settings: PrcAppBrandingSettings | undefined,
  fallback: { readonly appName: string; readonly appIcon?: string } = resolveEnvAppBranding(process.env),
): { readonly appName: string; readonly appIcon?: string } {
  const appName = settings?.appName?.trim() || fallback.appName;
  const appIcon = settings?.appIconUrl?.trim() || fallback.appIcon;
  return { appName, ...(appIcon ? { appIcon } : {}) };
}

function validateAppIconUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^(https?:\/\/|data:image\/|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  throw new Error("appIconUrl must be an image URL, path, or data:image URL");
}

function getExtensionHost(context: Pick<HttpApiServerContext, "extensions" | "extensionRuntime">): PrcExtensionHost | undefined {
  return context.extensionRuntime?.current ?? context.extensions;
}

/**
 * Narrow context.extensionRuntime to non-null at a route entry, sending a
 * 400 to the client when the server was started without an extension runtime
 * configured (typical of standalone test harnesses). Eight extension-routes
 * had hand-rolled this guard before; centralize so they all use the same
 * error shape and the route body can use a properly-narrowed local.
 */
function requireExtensionRuntime(
  context: Pick<HttpApiServerContext, "extensionRuntime">,
  res: http.ServerResponse,
  label: string,
): PrcExtensionRuntime | null {
  if (context.extensionRuntime) return context.extensionRuntime;
  sendJson(res, 400, { error: `${label} is not configured` });
  return null;
}

async function mutateExtensionSettings(
  runtime: PrcExtensionRuntime,
  mutation: () => Promise<PrcSettings>,
): Promise<{ settings: PrcSettings; result: Awaited<ReturnType<PrcExtensionRuntime["reload"]>> }> {
  const previous = await readPrcSettings(runtime.configDir);
  const settings = await mutation();
  const result = await runtime.reload();
  if (!result.applied) {
    await writePrcSettings(runtime.configDir, previous);
    return { settings: previous, result };
  }
  return { settings, result };
}

function createExtensionSessionApi(registry: SessionRegistry) {
  return {
    create: async (input: { readonly cwd: string; readonly sessionName?: string }) => {
      const session = await registry.createSession(input);
      const state = await session.handle.getState();
      return toSessionCard(state);
    },
    prompt: async (sessionId: string, prompt: string) => {
      await registry.prompt(sessionId, prompt);
    },
    createAndPrompt: async (input: { readonly cwd: string; readonly sessionName?: string; readonly prompt: string }) => {
      const session = await registry.createSession(input);
      await registry.prompt(session.id, input.prompt);
      const state = await session.handle.getState();
      return toSessionCard(state);
    },
    get: async (sessionId: string) => {
      const state = await registry.getSession(sessionId).handle.getState();
      return toSessionCard(state);
    },
    getForkMessages: async (sessionId: string) => registry.getForkMessages(sessionId),
    forkSession: async (sessionId: string, entryId: string) => {
      const { result, session } = await registry.forkSession(sessionId, entryId);
      return { ...result, session: toSessionCard(await session.handle.getState()) };
    },
    cloneSession: async (sessionId: string) => {
      const { result, session } = await registry.cloneSession(sessionId);
      return { ...result, session: toSessionCard(await session.handle.getState()) };
    },
  };
}

function createClientEventLog(filePath: string): ClientEventLog {
  let queue: Promise<void> = Promise.resolve();
  // In-memory ring of (serverTs, payload) pairs. Used by stats() only;
  // does not affect the on-disk log. Pre-allocated array + head index so
  // additions are O(1) and don't generate GC churn under load.
  const ring: Array<{ ts: number; payload: Record<string, unknown> } | undefined> = new Array(CLIENT_EVENT_RING_CAPACITY);
  let ringHead = 0; // next slot to write
  let totalAppended = 0;
  return {
    append(payload) {
      const ts = typeof payload.serverTs === "number" ? payload.serverTs : Date.now();
      ring[ringHead] = { ts, payload };
      ringHead = (ringHead + 1) % CLIENT_EVENT_RING_CAPACITY;
      totalAppended += 1;
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
    stats(windowMs: number): ClientEventStats {
      return summarizeClientEventRing(ring, windowMs, totalAppended);
    },
  };
}

/**
 * Pure-function aggregation over the ring. Exported (via the in-test
 * factory below) so tests can pin the histogram shape without spinning up
 * a real HTTP server.
 */
export function summarizeClientEventRing(
  ring: ReadonlyArray<{ ts: number; payload: Record<string, unknown> } | undefined>,
  windowMs: number,
  totalAppended: number,
): ClientEventStats {
  const cutoff = Date.now() - windowMs;
  const byKind: Record<string, number> = {};
  const byApiErrorStatus: Record<string, number> = {};
  const sessionCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  let total = 0;
  for (const slot of ring) {
    if (!slot) continue;
    if (slot.ts < cutoff) continue;
    total += 1;
    const kind = typeof slot.payload.kind === "string" ? slot.payload.kind : "<unknown>";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const sid = typeof slot.payload.sessionId === "string" ? slot.payload.sessionId : null;
    if (sid) sessionCounts.set(sid, (sessionCounts.get(sid) ?? 0) + 1);
    if (kind === "api-error") {
      const status = String(slot.payload.status ?? "unknown");
      byApiErrorStatus[status] = (byApiErrorStatus[status] ?? 0) + 1;
      const p = typeof slot.payload.path === "string" ? slot.payload.path : null;
      if (p) pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
    }
  }
  const topSessions = [...sessionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sessionId, count]) => ({ sessionId, count }));
  const topApiErrorPaths = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([p, count]) => ({ path: p, count }));
  // bufferDropped tells operators if their window covers the buffer (i.e. is
  // their stats query missing data because the ring overwrote it?).
  const bufferDropped = Math.max(0, totalAppended - CLIENT_EVENT_RING_CAPACITY);
  return { windowMs, total, bufferDropped, byKind, byApiErrorStatus, topSessions, topApiErrorPaths };
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
  const port = Number(process.env.PI_CRUST_API_PORT ?? 8787);
  const host = process.env.PI_CRUST_API_HOST ?? "127.0.0.1";
  const projectRoot = path.resolve(process.env.PI_CRUST_PROJECT_ROOT ?? process.env.HOME ?? process.cwd());
  const sessionRoot = path.resolve(process.env.PI_CRUST_SESSION_ROOT ?? path.join(os.homedir(), ".pi", "agent", "sessions"));
  const adapterKind = process.env.PI_CRUST_USE_MOCK === "1"
    ? "mock"
    : process.env.PI_CRUST_ADAPTER === "pi-sdk"
      ? "pi-sdk"
      : "pirpc";
  const registry = createDefaultRegistry(adapterKind, sessionRoot, projectRoot);
  const serverDefaultCwd = isPathWithinRoot(process.cwd(), projectRoot) ? process.cwd() : projectRoot;
  const extensionRuntime = await createPrcExtensionRuntime({
    configDir: defaultPrcConfigDir(process.env),
    cwd: projectRoot,
    env: process.env,
    dataDir: path.resolve(process.env.PI_CRUST_DATA_DIR ?? path.join(os.homedir(), ".pi-crust", "data")),
    bundledPackagePaths: resolveOfficialExtensionPackages(),
    sessions: createExtensionSessionApi(registry),
  });
  if (extensionRuntime.current.diagnostics.length > 0) {
    for (const diagnostic of extensionRuntime.current.diagnostics) console.warn(`[extensions] ${diagnostic.extensionId}: ${diagnostic.message}`);
  }
  const clientEventLogPath = process.env.PI_CRUST_CLIENT_EVENT_LOG
    ?? path.resolve(process.cwd(), "logs", "client-events.jsonl");
  // Live SHA: recomputed when .git/HEAD changes so /api/health doesn't lie
  // about the build after a `git pull` lands new commits.
  const gitSha = createLiveGitSha({ cwd: process.cwd(), env: process.env });
  const server = createHttpApiServer({
    registry,
    adapterKind,
    projectRoot,
    sessionRoot,
    defaultCwd: serverDefaultCwd,
    clientEventLogPath,
    gitSha,
    extensionRuntime,
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
      console.error(`pi-crust API: port ${port} on ${host} is already in use.`);
      console.error(`hint: find the holder with: lsof -ti :${port}    (or: ss -tlnp | grep ${port})`);
      // Exit cleanly so a supervisor loop can back off rather than crash-loop
      // on an unhandled 'error' event. Code 2 is the canonical "bad config"
      // exit code outer loops can react to.
      process.exit(2);
    }
    console.error(`pi-crust API: server error: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`pi-crust API listening on http://${host}:${port}`);
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
    // Session-handle health snapshot. Surfaces silently-broken handles
    // (the 2026-05-24 outage signature) before users hit them. A non-zero
    // `sessions.broken` is the leading indicator that the API needs a
    // bounce or (post-PR-D) a reconnect.
    const sessions = context.registry.getSessionHealthSnapshot();
    return sendJson(res, 200, {
      ok: true,
      adapter: context.adapterKind,
      projectRoot: context.projectRoot,
      sessionRoot: context.sessionRoot,
      defaultCwd: context.defaultCwd ?? process.cwd(),
      // The user's home directory (server-side). The pi-crust uses this as the
      // default 'Working directory' in the New Session dialog, which is
      // friendlier than seeding it with whatever the API was invoked from.
      homeCwd: os.homedir(),
      ...(await resolveAppBranding(context)),
      gitSha: resolveContextGitSha(context.gitSha),
      sessions: {
        total: sessions.total,
        healthy: sessions.healthy,
        broken: sessions.broken,
        ...(sessions.broken > 0 ? { brokenSessionIds: sessions.brokenSessionIds } : {}),
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/client-event") {
    return handleClientEvent(req, res, context);
  }

  if (req.method === "GET" && url.pathname === "/api/client-event/stats") {
    // Aggregated histogram over the most recent client telemetry events,
    // computed from an in-memory ring buffer. Lets an operator (or the
    // dashboard) see "how many api-errors / sse-silences in last 5 minutes?"
    // without grepping /home/coder/.../client-events.jsonl. The defaults
    // target the dashboard's polling cadence; max is capped to avoid CPU
    // pegging on a pathological query.
    const requestedMs = Number(url.searchParams.get("windowMs") ?? 5 * 60_000);
    const windowMs = Math.max(1_000, Math.min(60 * 60_000, Number.isFinite(requestedMs) ? requestedMs : 5 * 60_000));
    const stats = context.clientEventLog?.stats(windowMs) ?? {
      windowMs,
      total: 0,
      bufferDropped: 0,
      byKind: {},
      byApiErrorStatus: {},
      topSessions: [],
      topApiErrorPaths: [],
    };
    return sendJson(res, 200, stats);
  }

  if (req.method === "GET" && url.pathname === "/api/extensions") {
    return sendJson(res, 200, serializeExtensions(getExtensionHost(context)));
  }

  if (req.method === "GET" && url.pathname === "/api/extensions/settings") {
    const runtime = requireExtensionRuntime(context, res, "extension settings");
    if (!runtime) return;
    const settings = await readPrcSettings(runtime.configDir);
    return sendJson(res, 200, { ...settings, extensions: serializeExtensions(runtime.current) });
  }

  if (req.method === "POST" && url.pathname === "/api/settings/branding") {
    const runtime = requireExtensionRuntime(context, res, "settings");
    if (!runtime) return;
    const body = await readJson(req) as { appName?: unknown; appIconUrl?: unknown };
    if (body.appName !== undefined && typeof body.appName !== "string") return sendJson(res, 400, { error: "appName must be a string" });
    if (body.appIconUrl !== undefined && typeof body.appIconUrl !== "string") return sendJson(res, 400, { error: "appIconUrl must be a string" });
    let appIconUrl: string | undefined;
    try {
      appIconUrl = validateAppIconUrl(body.appIconUrl ?? "");
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    const appName = (body.appName ?? "").trim();
    const settings = await readPrcSettings(runtime.configDir);
    const appBranding: PrcAppBrandingSettings = {
      ...(appName ? { appName } : {}),
      ...(appIconUrl ? { appIconUrl } : {}),
    };
    const next: PrcSettings = Object.keys(appBranding).length > 0
      ? { ...settings, appBranding }
      : Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "appBranding")) as PrcSettings;
    await writePrcSettings(runtime.configDir, next);
    return sendJson(res, 200, effectiveAppBranding(next.appBranding));
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const runtime = requireExtensionRuntime(context, res, "settings");
    if (!runtime) return;
    const body = await readJson(req) as { key?: unknown; value?: unknown };
    if (typeof body.key !== "string" || body.key.trim().length === 0) {
      return sendJson(res, 400, { error: "key must be a non-empty string" });
    }
    const key = body.key.trim();
    if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(key)) {
      return sendJson(res, 400, { error: "key must be a dotted alphanumeric path (e.g. presentations.templateDirs)" });
    }
    const settings = await readPrcSettings(runtime.configDir);
    const next = applyDottedSetting(settings as unknown as Record<string, unknown>, key, body.value);
    await writePrcSettings(runtime.configDir, next as PrcSettings);
    const reload = await runtime.reload();
    return sendJson(res, reload.applied ? 200 : 400, {
      settings: next,
      ...reload,
      extensions: serializeExtensions(runtime.current),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/extensions/reload") {
    const runtime = requireExtensionRuntime(context, res, "extension reload");
    if (!runtime) return;
    const result = await runtime.reload();
    return sendJson(res, result.applied ? 200 : 400, { ...result, extensions: serializeExtensions(runtime.current) });
  }

  if (req.method === "POST" && url.pathname === "/api/extensions/packages") {
    const runtime = requireExtensionRuntime(context, res, "extension package installs");
    if (!runtime) return;
    const body = await readJson(req) as { source?: string };
    if (!body.source) return sendJson(res, 400, { error: "source is required" });
    const source = body.source;
    const response = await mutateExtensionSettings(runtime, async () => installExtensionPackage(source, { configDir: runtime.configDir, cwd: runtime.cwd }));
    return sendJson(res, response.result.applied ? 200 : 400, { settings: response.settings, ...response.result, extensions: serializeExtensions(runtime.current) });
  }

  if (req.method === "POST" && url.pathname === "/api/extensions/packages/remove") {
    const runtime = requireExtensionRuntime(context, res, "extension package removes");
    if (!runtime) return;
    const body = await readJson(req) as { source?: string };
    if (!body.source) return sendJson(res, 400, { error: "source is required" });
    const source = body.source;
    const response = await mutateExtensionSettings(runtime, async () => removeExtensionPackage(source, { configDir: runtime.configDir, cwd: runtime.cwd }));
    return sendJson(res, response.result.applied ? 200 : 400, { settings: response.settings, ...response.result, extensions: serializeExtensions(runtime.current) });
  }

  const extensionEnabledMatch = url.pathname.match(/^\/api\/extensions\/([^/]+)\/enabled$/);
  if (req.method === "POST" && extensionEnabledMatch) {
    const runtime = requireExtensionRuntime(context, res, "extension settings");
    if (!runtime) return;
    const body = await readJson(req) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") return sendJson(res, 400, { error: "enabled boolean is required" });
    const extensionId = decodeURIComponent(extensionEnabledMatch[1]!);
    const enabled = body.enabled;
    const response = await mutateExtensionSettings(runtime, async () => setExtensionEnabled(runtime.configDir, extensionId, enabled));
    return sendJson(res, response.result.applied ? 200 : 400, { settings: response.settings, ...response.result, extensions: serializeExtensions(runtime.current) });
  }

  const extensionAssetMatch = url.pathname.match(/^\/api\/extensions\/([^/]+)\/assets\/([^/]+)$/);
  if (req.method === "GET" && extensionAssetMatch) {
    const asset = getExtensionHost(context)?.getWebAsset(decodeURIComponent(extensionAssetMatch[1]!));
    if (!asset || path.basename(asset.filePath) !== decodeURIComponent(extensionAssetMatch[2]!)) return sendJson(res, 404, { error: "extension asset not found" });
    return serveExtensionAsset(asset.filePath, res);
  }

  const extensionCommandMatch = url.pathname.match(/^\/api\/extensions\/([^/]+)\/commands\/([^/]+)$/);
  if (req.method === "POST" && extensionCommandMatch) {
    return handleExtensionCommand(req, res, context, decodeURIComponent(extensionCommandMatch[1]!), decodeURIComponent(extensionCommandMatch[2]!));
  }

  if (url.pathname.startsWith("/api/extensions/")) {
    const extensionResponse = await getExtensionHost(context)?.serverRoutes.dispatch(req, url);
    if (extensionResponse) return sendJsonWithHeaders(res, extensionResponse.status ?? 200, extensionResponse.body, extensionResponse.headers);
    return sendJson(res, 404, { error: "extension route not found" });
  }

  const apiExtensionResponse = await getExtensionHost(context)?.serverRoutes.dispatch(req, url);
  if (apiExtensionResponse) return sendJsonWithHeaders(res, apiExtensionResponse.status ?? 200, apiExtensionResponse.body, apiExtensionResponse.headers);

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    return sendJson(res, 200, await dedupedListSessionCards(context, cwd));
  }

  if (req.method === "GET" && url.pathname === "/api/sessions/statuses") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    return sendJson(res, 200, await dedupedListSessionCards(context, cwd));
  }

  // Serve arbitrary on-disk artifact files (images, html, pdf, video) that
  // live outside the bundled pi-crust static root — e.g. /tmp/foo.png produced by
  // an agent and referenced by `show_artifact`. The candidate path must
  // resolve (post-realpath) inside the OS tmpdir, the user's home, the
  // project root, the session root, or the default cwd. See
  // src/server/artifact-file.ts for the full policy.
  if (req.method === "GET" && url.pathname === "/api/artifact-file") {
    const candidate = url.searchParams.get("path");
    if (!candidate) return sendJson(res, 400, { error: "path query parameter is required" });
    const result = await resolveArtifactFile(candidate, {
      allowedRoots: defaultArtifactFileRoots([
        context.projectRoot,
        context.sessionRoot,
        ...(context.defaultCwd ? [context.defaultCwd] : []),
      ]),
    });
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    return streamArtifactFile(result.resolution, res);
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req) as { cwd?: string; sessionName?: string };
    if (!body.cwd) return sendJson(res, 400, { error: "cwd is required" });
    const created = await context.registry.createSession({ cwd: body.cwd, ...(body.sessionName ? { sessionName: body.sessionName } : {}) });
    const state = await created.handle.getState();
    context.coldSessionFiles.set(created.id, created.sessionFile);
    return sendJson(res, 200, toSessionCard(state));
  }

  // Static-UI fallback. When PI_CRUST_UI_DIR is set (typically by the
  // `bin/pi-crust` launcher pointing at the built Vite output), any
  // GET that didn't match an /api route falls through to file serving so a
  // single process can host both the API and the pi-crust. SPA semantics: unknown
  // routes fall back to index.html so client-side routes Just Work.
  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const uiDir = process.env.PI_CRUST_UI_DIR;
    if (uiDir) {
      const served = await tryServeStatic(uiDir, url.pathname, res);
      if (served) return;
    }
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/((?:messages(?:\/[^/]+\/(?:images\/\d+|details|tool-output))?)|prompt|bash|abort|rename|delete|model|state|events|extension-ui-response))?$/);
  if (!match) return sendJson(res, 404, { error: "not found" });
  const sessionId = decodeURIComponent(match[1]!);
  const action = match[2] ?? "state";

  if (req.method === "GET" && action === "events") {
    const session = await getOrOpenSession(context, sessionId);
    // Evict any prior SSE for the same browser tab before sending headers.
    // The pi-crust passes its per-tab id (sessionStorage-scoped) as a query param;
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
    // replayed when the pi-crust reconnects.
    const lastEventHeader = req.headers["last-event-id"];
    const lastEventId = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
    const fromSeq = lastEventId && /^-?\d+$/.test(lastEventId) ? Number(lastEventId) : null;

    const writeEvent = (event: unknown, seq: number) => {
      try {
        const data = JSON.stringify(event);
        // session_resync gets its own named event type so the pi-crust can refetch
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
    const limitRaw = url.searchParams.get("limit");
    const beforeRaw = url.searchParams.get("before");
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Number(limitRaw), MAX_MESSAGES_LIMIT) : undefined;
    const before = beforeRaw && /^-?\d+$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
    let messages: readonly SessionMessage[];
    if (limit !== undefined) {
      // Tail-window query: read only the trailing chunk of the session file
      // directly so a huge transcript doesn't have to be slurped + parsed in
      // full. Falls back to the adapter if a tail-read isn't possible (e.g.
      // session file doesn't exist on disk yet).
      const tail = await readSessionMessagesTail(session.sessionFile, before === undefined ? { limit } : { limit, before });
      if (tail === undefined) {
        // Fallback for adapters / files that the tail-reader can't parse
        // (e.g. the mock adapter's pretty-printed JSON blobs). Apply the
        // same `before:` cursor semantics the tail-reader implements so
        // pagination works uniformly regardless of which code path serves
        // the request.
        let all = await session.handle.getMessages();
        if (before !== undefined) {
          all = all.filter((m) => typeof m.timestamp !== "number" || m.timestamp < before);
        }
        messages = all.slice(-limit);
      } else {
        messages = tail;
      }
    } else {
      messages = await session.handle.getMessages();
    }
    return sendJson(res, 200, toDashboardMessages(messages, { sessionId: session.id }));
  }

  // Shared by the three /messages/:msgid/{images,details,tool-output}
  // routes below: open the session and find one message by id.
  const lookupContext = { getOrOpenSession: (id: string) => getOrOpenSession(context, id) };

  // Lazy fetch of inline image bytes that we strip from /messages payloads
  // to keep the timeline JSON small. Image URLs are issued by
  // toDashboardMessages; this route resolves them back to raw bytes.
  const imageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/(\d+)$/);
  if (req.method === "GET" && imageMatch) {
    const message = await lookupSessionMessage(lookupContext, decodeURIComponent(imageMatch[1]!), decodeURIComponent(imageMatch[2]!));
    const image = messageImageAt(message, Number(imageMatch[3]!));
    if (!image) return sendJson(res, 404, { error: "image not found" });
    const bytes = Buffer.from(image.data, "base64");
    res.writeHead(200, {
      "Content-Type": image.mimeType || "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=300",
    });
    res.end(bytes);
    return;
  }

  // Lazy fetch of full custom-message details (e.g. a full presentation
  // deck) that we strip from /messages payloads when the inline JSON
  // exceeds MAX_INLINE_DETAILS_BYTES.
  const detailsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/details$/);
  if (req.method === "GET" && detailsMatch) {
    const message = await lookupSessionMessage(lookupContext, decodeURIComponent(detailsMatch[1]!), decodeURIComponent(detailsMatch[2]!));
    if (!message?.details) return sendJson(res, 404, { error: "details not found" });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    });
    res.end(JSON.stringify(message.details));
    return;
  }

  // Lazy fetch of full tool output that we truncate in /messages payloads.
  const toolOutputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/tool-output$/);
  if (req.method === "GET" && toolOutputMatch) {
    const message = await lookupSessionMessage(lookupContext, decodeURIComponent(toolOutputMatch[1]!), decodeURIComponent(toolOutputMatch[2]!));
    if (!message?.tool) return sendJson(res, 404, { error: "tool output not found" });
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    });
    res.end(message.tool.output ?? "");
    return;
  }

  if (req.method === "GET" && (action === "state" || action === undefined)) {
    const session = await getOrOpenSession(context, sessionId);
    const metadata = await readSessionTimelineMetadata(session.sessionFile);
    return sendJson(res, 200, toSessionCard(await session.handle.getState(), metadata));
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
    return sendJson(res, 200, toDashboardMessages(await updatedSession.handle.getMessages(), { sessionId: updatedSession.id }));
  }

  if (req.method === "POST" && action === "bash") {
    const body = await readJson(req) as { command?: string; includeInContext?: boolean };
    if (!body.command) return sendJson(res, 400, { error: "command is required" });
    // Temporary compatibility path: until the adapter exposes Pi's bash RPC operation directly,
    // add bash as a user-visible message and follow with a prompt asking Pi to run it.
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.prompt(session.id, `${body.includeInContext === false ? "Run this hidden shell command for operator context only" : "Run this shell command and consider its output"}: ${body.command}`);
    const updatedSession = await getOrOpenSession(context, session.id);
    return sendJson(res, 200, toDashboardMessages(await updatedSession.handle.getMessages(), { sessionId: updatedSession.id }));
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

// /sessions and /statuses fan out to listSessionCards, which is moderately
// expensive (filesystem walks, per-session head/tail scans, optional hot-
// session getState() RPCs). When the pi-crust mounts it commonly fires several
// of these in parallel — sidebar list, status snapshot for the active tab,
// reconnect after SSE handshake — and they all serialize on the Node event
// loop. Collapse a burst into one underlying computation per cwd, and reuse
// the result for a brief TTL so back-to-back polls cost ~0.
const LIST_SESSIONS_CACHE_TTL_MS = 750;
// Live worker state is an overlay on top of persisted session-list metadata.
// The sidebar/status endpoint must stay cheap even when a long-lived supervisor
// socket is stale, accepts a request but never replies, or has already been
// marked unhealthy by /api/health. Fall back to the list-card if a hot handle
// cannot answer within this budget.
const STATUS_LIVE_STATE_TIMEOUT_MS = 250;
interface SessionsCacheEntry {
  readonly expiresAt: number;
  readonly cards: Awaited<ReturnType<typeof listSessionCards>>;
}
const sessionsCardCache = new Map<string, SessionsCacheEntry>();
const sessionsCardInflight = new Map<string, Promise<Awaited<ReturnType<typeof listSessionCards>>>>();

async function dedupedListSessionCards(context: HttpApiServerContext, cwd?: string) {
  const key = cwd ?? "";
  const now = Date.now();
  const cached = sessionsCardCache.get(key);
  if (cached && cached.expiresAt > now) return cached.cards;
  const inflight = sessionsCardInflight.get(key);
  if (inflight) return inflight;
  const pending = listSessionCards(context, cwd)
    .then((cards) => {
      sessionsCardCache.set(key, { expiresAt: Date.now() + LIST_SESSIONS_CACHE_TTL_MS, cards });
      return cards;
    })
    .finally(() => { sessionsCardInflight.delete(key); });
  sessionsCardInflight.set(key, pending);
  return pending;
}

async function listSessionCards(context: HttpApiServerContext, cwd?: string) {
  const sessions = await context.registry.listSessions(cwd);
  for (const session of sessions) context.coldSessionFiles.set(session.id, session.sessionFile);
  const cards = await Promise.all(sessions.map((session) => sessionCardWithLiveState(context, session)));
  // Persist any updated timeline-metadata entries to disk so the next process
  // restart can skip re-scanning multi-MB session files on the cold path.
  await flushDirtyTimelineIndexes();
  return cards;
}

async function sessionCardWithLiveState(context: HttpApiServerContext, session: SessionListItem) {
  const metadata = await readSessionTimelineMetadata(session.sessionFile);
  if (context.registry.hasSession(session.id)) {
    const registered = context.registry.getSession(session.id);
    const handle = registered.handle;
    const isHealthy = typeof handle.isHealthy === "function" ? handle.isHealthy() : true;
    if (isHealthy) {
      try {
        const state = await withTimeout(handle.getState(), STATUS_LIVE_STATE_TIMEOUT_MS, `status live state for ${session.id}`);
        const card = toSessionCard(state, metadata);
        return {
          ...card,
          // getState() is an observation and some adapters report Date.now()
          // there. Sidebar snapshots should sort by real session activity from
          // the session index, not by the time this polling request ran.
          lastActivity: Number.isFinite(session.lastActivity) ? session.lastActivity : card.lastActivity,
        };
      } catch {
        // Fall back to the persisted list entry if the hot handle disappeared,
        // is stale, or fails to answer within the sidebar poll budget.
      }
    }
  }
  return toSessionListCard(session, metadata);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
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

// Window sizes for head/tail jsonl scans. createdAt sits at the very top of
// the file (the `type: "session"` record); lastUserActivity is approximated
// from the trailing window — sufficient for sidebar sort because sessions
// where the user only typed near the start of a very long transcript would
// have an old lastUserActivity anyway and sort by createdAt.
const TIMELINE_HEAD_SCAN_BYTES = 8 * 1024;
const TIMELINE_TAIL_SCAN_BYTES = 32 * 1024;
const TIMELINE_INDEX_FILENAME = ".pi-timeline-index.json";

const sessionTimelineMetadataCache = new Map<string, CachedSessionTimelineMetadata>();
// Track which session-file *directories* we've already loaded the persisted
// index from. Index files live alongside the jsonl session files so the next
// fresh server process can pick them up without re-scanning multi-MB files.
const loadedTimelineIndexDirs = new Set<string>();
const loadingTimelineIndexes = new Map<string, Promise<void>>();
const dirtyTimelineIndexDirs = new Set<string>();

async function readSessionTimelineMetadata(sessionFile: string): Promise<SessionTimelineMetadata> {
  if (!sessionFile) return { createdAt: null, lastUserActivity: null };
  const dir = path.dirname(sessionFile);
  await ensureTimelineIndexLoaded(dir);
  try {
    const stat = await fsp.stat(sessionFile);
    const cached = sessionTimelineMetadataCache.get(sessionFile);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.metadata;
    if (cached && stat.size > cached.size) {
      // Incremental update: only read the bytes that have been appended since
      // the last scan. This is the steady-state cost for the active session
      // (the one being typed into) so it dominates the /statuses budget.
      const metadata = await scanTimelineDelta(sessionFile, cached.size, stat.size, cached.metadata);
      sessionTimelineMetadataCache.set(sessionFile, { mtimeMs: stat.mtimeMs, size: stat.size, metadata });
      dirtyTimelineIndexDirs.add(dir);
      return metadata;
    }
    // Cold (or invalidated) scan: head + tail only, never the whole file.
    const metadata = await scanTimelineHeadAndTail(sessionFile, stat.size);
    sessionTimelineMetadataCache.set(sessionFile, { mtimeMs: stat.mtimeMs, size: stat.size, metadata });
    dirtyTimelineIndexDirs.add(dir);
    return metadata;
  } catch {
    // Missing/unreadable historical session files degrade to null metadata.
    return { createdAt: null, lastUserActivity: null };
  }
}

async function scanTimelineHeadAndTail(sessionFile: string, fileSize: number): Promise<SessionTimelineMetadata> {
  if (fileSize === 0) return { createdAt: null, lastUserActivity: null };
  const fd = await fsp.open(sessionFile, "r");
  try {
    let createdAt: number | null = null;
    let lastUserActivity: number | null = null;

    const headSize = Math.min(TIMELINE_HEAD_SCAN_BYTES, fileSize);
    const headBuf = Buffer.alloc(headSize);
    await fd.read(headBuf, 0, headSize, 0);
    const headHasFullFile = headSize === fileSize;
    // If the head window doesn't reach EOF the last line may be partial; drop
    // it so we don't JSON.parse half a record.
    const headText = headBuf.toString("utf8");
    const headSplit = headText.split("\n");
    const headLines = headHasFullFile ? headSplit : headSplit.slice(0, -1);
    for (const line of headLines) {
      const parsed = parseTimelineLine(line);
      if (!parsed) continue;
      if (parsed.createdAt !== undefined && createdAt === null) createdAt = parsed.createdAt;
      if (parsed.userActivity !== undefined) {
        lastUserActivity = Math.max(lastUserActivity ?? 0, parsed.userActivity);
      }
    }

    if (!headHasFullFile) {
      const tailStart = Math.max(headSize, fileSize - TIMELINE_TAIL_SCAN_BYTES);
      const tailSize = fileSize - tailStart;
      const tailBuf = Buffer.alloc(tailSize);
      await fd.read(tailBuf, 0, tailSize, tailStart);
      const tailText = tailBuf.toString("utf8");
      const firstNewline = tailText.indexOf("\n");
      const safeTail = firstNewline >= 0 ? tailText.slice(firstNewline + 1) : tailText;
      for (const line of safeTail.split("\n")) {
        const parsed = parseTimelineLine(line);
        if (!parsed) continue;
        if (parsed.userActivity !== undefined) {
          lastUserActivity = Math.max(lastUserActivity ?? 0, parsed.userActivity);
        }
      }
    }

    return { createdAt, lastUserActivity };
  } finally {
    await fd.close();
  }
}

async function scanTimelineDelta(sessionFile: string, oldSize: number, newSize: number, previous: SessionTimelineMetadata): Promise<SessionTimelineMetadata> {
  const delta = newSize - oldSize;
  if (delta <= 0) return previous;
  const fd = await fsp.open(sessionFile, "r");
  try {
    const buf = Buffer.alloc(delta);
    await fd.read(buf, 0, delta, oldSize);
    let lastUserActivity = previous.lastUserActivity;
    // The first byte after `oldSize` may be a continuation of a line that was
    // partially flushed before. The common case for our append-only sessions
    // is that we begin exactly at a newline boundary, so the conservative
    // approach is to just skip any incomplete leading line.
    const text = buf.toString("utf8");
    for (const line of text.split("\n")) {
      const parsed = parseTimelineLine(line);
      if (!parsed) continue;
      if (parsed.userActivity !== undefined) {
        lastUserActivity = Math.max(lastUserActivity ?? 0, parsed.userActivity);
      }
    }
    return { createdAt: previous.createdAt, lastUserActivity };
  } finally {
    await fd.close();
  }
}

function parseTimelineLine(line: string): { createdAt?: number | null; userActivity?: number } | undefined {
  if (!line || !line.trim()) return undefined;
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(entry)) return undefined;
  if (entry.type === "session") {
    return { createdAt: coerceTimestamp(entry.timestamp) ?? null };
  }
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  if (entry.message.role !== "user") return undefined;
  const timestamp = coerceTimestamp(entry.message.timestamp) ?? coerceTimestamp(entry.timestamp);
  if (timestamp === undefined) return undefined;
  return { userActivity: timestamp };
}

async function ensureTimelineIndexLoaded(dir: string): Promise<void> {
  if (loadedTimelineIndexDirs.has(dir)) return;
  let pending = loadingTimelineIndexes.get(dir);
  if (!pending) {
    pending = loadTimelineIndex(dir).finally(() => {
      loadingTimelineIndexes.delete(dir);
      loadedTimelineIndexDirs.add(dir);
    });
    loadingTimelineIndexes.set(dir, pending);
  }
  await pending;
}

async function loadTimelineIndex(dir: string): Promise<void> {
  const indexFile = path.join(dir, TIMELINE_INDEX_FILENAME);
  let content: string;
  try { content = await fsp.readFile(indexFile, "utf8"); } catch { return; }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return; }
  if (!isRecord(parsed)) return;
  const entries = isRecord(parsed.entries) ? parsed.entries : parsed;
  if (!isRecord(entries)) return;
  for (const [basename, value] of Object.entries(entries)) {
    if (!isRecord(value)) continue;
    const mtimeMs = typeof value.mtimeMs === "number" ? value.mtimeMs : null;
    const size = typeof value.size === "number" ? value.size : null;
    if (mtimeMs === null || size === null) continue;
    const createdAt = typeof value.createdAt === "number" ? value.createdAt : null;
    const lastUserActivity = typeof value.lastUserActivity === "number" ? value.lastUserActivity : null;
    const sessionFile = path.join(dir, basename);
    // Only adopt the persisted entry when the in-process cache hasn't already
    // observed a fresher state for that file.
    if (sessionTimelineMetadataCache.has(sessionFile)) continue;
    sessionTimelineMetadataCache.set(sessionFile, {
      mtimeMs,
      size,
      metadata: { createdAt, lastUserActivity },
    });
  }
}

async function flushDirtyTimelineIndexes(): Promise<void> {
  if (dirtyTimelineIndexDirs.size === 0) return;
  const dirs = [...dirtyTimelineIndexDirs];
  dirtyTimelineIndexDirs.clear();
  await Promise.all(dirs.map(async (dir) => {
    const entries: Record<string, unknown> = {};
    for (const [sessionFile, cached] of sessionTimelineMetadataCache) {
      if (path.dirname(sessionFile) !== dir) continue;
      entries[path.basename(sessionFile)] = {
        mtimeMs: cached.mtimeMs,
        size: cached.size,
        createdAt: cached.metadata.createdAt,
        lastUserActivity: cached.metadata.lastUserActivity,
      };
    }
    const indexFile = path.join(dir, TIMELINE_INDEX_FILENAME);
    const tmpFile = `${indexFile}.tmp`;
    try {
      await fsp.writeFile(tmpFile, JSON.stringify({ version: 1, entries }), "utf8");
      await fsp.rename(tmpFile, indexFile);
    } catch {
      // Best-effort; we'll try again on the next /statuses call.
    }
  }));
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

/**
 * Maximum number of messages a single /messages call is allowed to return.
 * Acts as a server-side safety net even if a client passes a huge ?limit.
 */
export const MAX_MESSAGES_LIMIT = 1000;
/**
 * Tool outputs longer than this are truncated in /messages responses; the
 * full text is fetchable via /messages/:messageId/tool-output. Keeps single
 * transcript responses small even when an assistant has run cat on a 30 MB
 * log.
 */
export const MAX_INLINE_TOOL_OUTPUT_BYTES = 16 * 1024;
/**
 * Custom-message `details` (extension artifacts — e.g. presentation decks
 * with full slide HTML) over this size are stripped from /messages responses
 * and replaced with a small stub the pi-crust can lazy-fetch on demand. Caps the
 * worst single message at this size and stops a deck-heavy session from
 * shipping tens of MB of inline JSON on every page mount.
 */
export const MAX_INLINE_DETAILS_BYTES = 32 * 1024;
/**
 * Tool artifacts are previews attached directly to tool-call rows. Some tools
 * (notably show_presentation) can embed full slide decks/HTML in
 * tool.artifact.data; that duplicates the custom artifact message and can make
 * a small tail-windowed /messages request tens of MB. Keep only a small preview
 * inline and omit heavyweight artifact bodies from the timeline payload.
 */
export const MAX_INLINE_TOOL_ARTIFACT_BYTES = 32 * 1024;

export interface ToDashboardMessagesOptions {
  /** When set, image bytes are stripped from the payload and replaced with a
   *  URL the pi-crust can fetch on demand. Tool outputs over the inline threshold
   *  are also truncated and given an `outputUrl` fallback. Without a
   *  sessionId we can't issue per-message URLs, so we leave the payload as-is
   *  for unit-test back-compat. */
  readonly sessionId?: string;
}

export function toDashboardMessages(messages: readonly SessionMessage[], options: ToDashboardMessagesOptions = {}) {
  const sessionId = options.sessionId;
  return messages.map((message, index) => {
    const id = `${message.timestamp}-${index}`;
    // Normalize structured content arrays into visible-text + thinking +
    // images. SessionMessage.content is *typed* as `string`, but the
    // tail-read fast path in readSessionMessagesTail() returns raw JSONL
    // records whose content is the on-disk array-of-blocks shape (text /
    // thinking / toolCall / image). Without this fan-out the pi-crust sees the
    // array as `text` and the safe-markdown coercion stringifies it into
    // the bubble — producing literal `[ { "type": "toolCall", ... } ]`
    // text instead of the expected Markdown body + thinking card + tool
    // row. Pinned by tests/playwright/structured-content-tool-calls.spec.ts.
    const normalized = typeof message.content === "string"
      ? { text: message.content as string, thinking: "", images: [] as readonly { readonly data: string; readonly mimeType: string }[] }
      : contentTextAndThinking(message.content);
    // Prefer images extracted from the content array (real pirpc shape)
    // over message.images, which the adapter only populates on its own
    // normalization path.
    const images = normalized.images.length > 0 ? normalized.images : message.images;
    const thinking = message.thinking ?? (normalized.thinking ? normalized.thinking : undefined);
    return {
      id,
      role: message.role === "assistant"
        ? "assistant"
        : message.role === "user"
          ? "user"
          : message.role === "tool"
            ? "tool"
            : message.role === "summary"
              ? "summary"
              : "custom",
      text: normalized.text,
      provider: message.role === "assistant" ? "pi" : undefined,
      tool: message.tool ? stripToolForTransport(message.tool, sessionId, id) : undefined,
      images: sessionId && images ? stripImagesForTransport(images, sessionId, id) : images,
      timestamp: message.timestamp,
      ...(message.customType ? { customType: message.customType } : {}),
      ...(message.details ? stripDetailsForTransport(message.details, sessionId, id) : {}),
      ...(message.stopReason ? { stopReason: message.stopReason } : {}),
      ...(message.errorMessage ? { error: message.errorMessage } : {}),
      ...(thinking ? { thinking } : {}),
      ...(message.summaryKind ? { summaryKind: message.summaryKind } : {}),
    };
  });
}

function stripImagesForTransport(images: readonly { readonly data: string; readonly mimeType: string }[], sessionId: string, messageId: string) {
  return images.map((image, imageIndex) => ({
    mimeType: image.mimeType,
    url: `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/images/${imageIndex}`,
  }));
}

function messageImages(message: SessionMessage | undefined): readonly { readonly data: string; readonly mimeType: string }[] {
  if (!message) return [];
  const normalized = typeof message.content === "string" ? { images: [] as readonly { readonly data: string; readonly mimeType: string }[] } : contentTextAndThinking(message.content);
  return normalized.images.length > 0 ? normalized.images : (message.images ?? []);
}

function messageImageAt(message: SessionMessage | undefined, imageIndex: number) {
  if (!Number.isInteger(imageIndex) || imageIndex < 0) return undefined;
  return messageImages(message)[imageIndex];
}

function stripToolForTransport(tool: NonNullable<SessionMessage["tool"]>, sessionId: string | undefined, messageId: string) {
  const output = tool.output ?? "";
  const artifact = stripToolArtifactForTransport(tool.artifact);
  const toolWithArtifact = artifact === tool.artifact ? tool : { ...tool, artifact };
  if (!sessionId || Buffer.byteLength(output, "utf8") <= MAX_INLINE_TOOL_OUTPUT_BYTES) return toolWithArtifact;
  // Keep the first/last few KB inline so the UI still shows context without
  // a second round-trip. The exact midpoint is replaced with a marker that
  // includes the byte count and a URL to the full payload.
  const halfWindow = Math.floor(MAX_INLINE_TOOL_OUTPUT_BYTES / 2);
  const head = output.slice(0, halfWindow);
  const tail = output.slice(-halfWindow);
  const fullBytes = Buffer.byteLength(output, "utf8");
  const outputUrl = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/tool-output`;
  const truncated = `${head}\n\n…[${(fullBytes / 1024).toFixed(0)} KB truncated — full output at ${outputUrl}]…\n\n${tail}`;
  return { ...toolWithArtifact, output: truncated, outputTruncated: true, outputUrl, outputFullBytes: fullBytes };
}

function stripToolArtifactForTransport(artifact: unknown): unknown {
  if (!artifact || typeof artifact !== "object") return artifact;
  let serialised: string;
  try { serialised = JSON.stringify(artifact); } catch { return artifact; }
  const fullBytes = Buffer.byteLength(serialised, "utf8");
  if (fullBytes <= MAX_INLINE_TOOL_ARTIFACT_BYTES) return artifact;

  const source = artifact as Record<string, unknown>;
  const preview: Record<string, unknown> = {
    artifactTruncated: true,
    artifactFullBytes: fullBytes,
  };
  for (const key of ["version", "kind", "title", "path", "url", "mimeType", "alt"] as const) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") preview[key] = value;
  }
  // Preserve small textual previews when available, but never inline the large
  // body fields (`data`, `html`, `markdown`) that caused multi-MB timelines.
  for (const key of ["html", "markdown"] as const) {
    const value = source[key];
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_INLINE_TOOL_ARTIFACT_BYTES) preview[key] = value;
  }
  if (source.data !== undefined) preview.data = { __omitted: true };
  if (source.html !== undefined && preview.html === undefined) preview.html = "…[truncated]";
  if (source.markdown !== undefined && preview.markdown === undefined) preview.markdown = "…[truncated]";
  return preview;
}

/**
 * Strips heavy fields out of a custom-message `details` blob (extension
 * artifacts: presentation decks, large HTML artifacts, etc.) and replaces
 * the omitted payload with a stub the pi-crust can fetch lazily via
 * /api/sessions/:id/messages/:msgId/details.
 *
 * Heuristic: serialise details, measure bytes. If under the threshold,
 * pass through unchanged. If over, return a stub `{ details: {...},
 * detailsUrl, detailsTruncated, detailsFullBytes }` with as much top-level
 * metadata as we can salvage cheaply so the pi-crust can show a card preview
 * without the full payload (title / kind / artifact-group-id all fit in a
 * few hundred bytes).
 */
function stripDetailsForTransport(
  details: Record<string, unknown>,
  sessionId: string | undefined,
  messageId: string,
): { details: Record<string, unknown>; detailsUrl?: string; detailsTruncated?: boolean; detailsFullBytes?: number } {
  if (!sessionId) return { details };
  let serialised: string;
  try { serialised = JSON.stringify(details); } catch { return { details }; }
  const fullBytes = Buffer.byteLength(serialised, "utf8");
  if (fullBytes <= MAX_INLINE_DETAILS_BYTES) return { details };
  const detailsUrl = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/details`;
  // Salvage a shallow preview of the details object: keep small scalar fields
  // and string fields capped at 256 chars; replace large nested values with
  // a sentinel. Lets the pi-crust render "presentation: <title>" or similar
  // without the full deck payload.
  const preview: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) { preview[key] = value; continue; }
    const t = typeof value;
    if (t === "number" || t === "boolean") { preview[key] = value; continue; }
    if (t === "string") {
      const str = value as string;
      preview[key] = str.length > 256 ? `${str.slice(0, 256)}…[truncated]` : str;
      continue;
    }
    preview[key] = { __omitted: true, kind: Array.isArray(value) ? "array" : "object" };
  }
  return {
    details: preview,
    detailsUrl,
    detailsTruncated: true,
    detailsFullBytes: fullBytes,
  };
}

/**
 * Reads up to `limit` recent SessionMessage entries from the end of a
 * jsonl-formatted session file without loading the whole file. Returns
 * undefined when the file can't be opened (caller should fall back to the
 * adapter). Multi-byte UTF-8 safe: we never decode a chunk until we have a
 * complete line boundary (newline).
 */
async function readSessionMessagesTail(
  sessionFile: string,
  options: { readonly limit: number; readonly before?: number },
): Promise<readonly SessionMessage[] | undefined> {
  if (!sessionFile) return undefined;
  let stat: import("node:fs").Stats;
  try { stat = await fsp.stat(sessionFile); } catch { return undefined; }
  if (!stat.isFile()) return undefined;
  // Treat an empty session file as "no on-disk transcript yet" and defer to
  // the adapter, which may still have in-memory messages (e.g. mock adapter
  // and fresh sessions whose first prompt hasn't been persisted).
  if (stat.size === 0) return undefined;

  const TAIL_CHUNK_SIZE = 64 * 1024;
  const fd = await fsp.open(sessionFile, "r");
  try {
    let position = stat.size;
    let leftover = Buffer.alloc(0);
    const collected: SessionMessage[] = [];
    // Track whether we saw ANY parseable jsonl record (message OR session
    // header). If a non-empty file produces zero such records the file
    // probably isn't a session jsonl at all (e.g. the mock adapter's
    // pretty-printed .mock-session.json blobs) — fall back to the adapter
    // rather than silently returning an empty timeline.
    let sawSessionShapedRecord = false;

    while (position > 0 && collected.length < options.limit) {
      const readSize = Math.min(TAIL_CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      await fd.read(chunk, 0, readSize, position);
      const buf = leftover.length === 0 ? chunk : Buffer.concat([chunk, leftover]);

      let parseStart = 0;
      if (position > 0) {
        // Bytes before the first newline could be the tail of an earlier
        // (still-unread) line. Save them for the next iteration and parse
        // everything after the first newline.
        const firstNewline = buf.indexOf(0x0a);
        if (firstNewline === -1) {
          leftover = buf;
          continue;
        }
        leftover = buf.subarray(0, firstNewline);
        parseStart = firstNewline + 1;
      } else {
        leftover = Buffer.alloc(0);
      }

      const text = buf.subarray(parseStart).toString("utf8");
      const lines = text.split("\n");
      // We collect the *raw* JSONL message bodies in this pass and run
      // them through toSessionMessages() at the end so the on-disk
      // pirpc / Anthropic-messages shape (assistant turns with
      // `content: [...toolCall blocks]` and free-standing
      // `role: "toolResult"` records) gets fanned out into the same
      // assistant + role:"tool" + role:"summary" sequence the adapter's
      // own getMessages() path produces. Without that fan-out,
      // toDashboardMessages sees `role: "toolResult"`, falls through to
      // "custom" and the pi-crust renders the result body as a free-standing
      // "Extension"-labelled bubble instead of merging the output into
      // the matching tool row. Regression introduced in PR #102 alongside
      // this tail-read path; pinned by
      // tests/playwright/structured-content-tool-calls.spec.ts.
      const fresh: unknown[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!isRecord(entry)) continue;
        if (entry.type === "session" || entry.type === "message" || entry.type === "session_info" || entry.type === "custom_message") {
          sawSessionShapedRecord = true;
        }
        // The numeric timestamp lives on the outer wrapper as an ISO
        // string; the inner message often doesn't carry its own. Coerce
        // and stamp it onto the message so downstream consumers (the
        // before-filter here, toSessionMessages, the pi-crust ordering) all
        // see a consistent number.
        let innerMessage: Record<string, unknown> | undefined;
        if (entry.type === "message" && isRecord(entry.message)) {
          innerMessage = entry.message as Record<string, unknown>;
        } else if (entry.type === "custom_message" && typeof entry.customType === "string") {
          // `type: "custom_message"` entries -- e.g. the artifact
          // records the @cemoody/pi-artifact `display(...)` tool writes
          // -- store their message body flat on the OUTER record (no
          // nested `.message` field). Strip the wrapper-only fields so
          // toSessionMessages sees the same shape it does for the
          // adapter's in-memory getMessages() path (which DOES emit
          // these via its `role === "custom" || customType.length > 0`
          // branch). Without this branch the tail-read fast path
          // silently drops every artifact custom-message on reload,
          // which means MessageTimeline's ArtifactView has nothing to
          // render and the user sees only the bare `display` tool card.
          const { type: _wrapperType, id: _wrapperId, parentId: _wrapperParent, display: _wrapperDisplay, timestamp: _wrapperTimestamp, ...rest } = entry as Record<string, unknown>;
          innerMessage = { role: "custom", ...rest };
        }
        if (!innerMessage) continue;
        let timestamp: number | undefined;
        if (typeof innerMessage.timestamp === "number") timestamp = innerMessage.timestamp;
        else if (typeof entry.timestamp === "string") {
          const parsed = Date.parse(entry.timestamp);
          if (!Number.isNaN(parsed)) timestamp = parsed;
        } else if (typeof entry.timestamp === "number") timestamp = entry.timestamp;
        if (options.before !== undefined && timestamp !== undefined && timestamp >= options.before) continue;
        fresh.push(timestamp === undefined ? innerMessage : { ...innerMessage, timestamp });
      }
      // unshift in collected-but-still-raw form; we flatten once at the
      // end so toSessionMessages's toolCall/toolResult index works
      // across the whole window, not per-chunk.
      collected.unshift(...(fresh as SessionMessage[]));
    }
    if (!sawSessionShapedRecord) return undefined;
    // Run the full raw-JSONL window through toSessionMessages so the
    // adapter's structured-content fan-out (toolCall blocks -> synthetic
    // role:"tool" entries, toolResult records merged into the matching
    // tool entry, thinking blocks split into the assistant's `thinking`
    // field) applies uniformly. THEN apply the limit, since the fan-out
    // can change the message count (one assistant turn with N toolCall
    // blocks expands to 1 assistant + N tool rows).
    const normalized = toSessionMessages(collected);
    return normalized.slice(-options.limit);
  } finally {
    await fd.close();
  }
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function handleExtensionCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: HttpApiServerContext,
  extensionId: string,
  invocationName: string,
): Promise<void> {
  const command = getExtensionHost(context)?.commands.get(invocationName);
  if (!command || command.extensionId !== extensionId) return sendJson(res, 404, { error: "extension command not found" });
  const input = await readJson(req);
  const result = await command.run(input);
  return sendJson(res, 200, { result });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  return sendJsonWithHeaders(res, status, data);
}

function sendJsonWithHeaders(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  setCors(res);
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (status === 204) {
    res.end();
    return;
  }
  if (data instanceof Uint8Array) {
    if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", "application/octet-stream");
    if (!res.hasHeader("Content-Length")) res.setHeader("Content-Length", String(data.byteLength));
    res.end(data);
    return;
  }
  const contentType = String(res.getHeader("Content-Type") ?? "");
  if (typeof data === "string" && contentType && !contentType.includes("json")) {
    if (!res.hasHeader("Content-Length")) res.setHeader("Content-Length", String(Buffer.byteLength(data)));
    res.end(data);
    return;
  }
  if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
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

async function serveExtensionAsset(filePath: string, res: http.ServerResponse): Promise<void> {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) return sendJson(res, 404, { error: "extension asset not found" });
  const ext = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", STATIC_MIME[ext] ?? "application/octet-stream");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "no-cache");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}

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

/**
 * Resolve the four official pi-crust extension packages from node_modules.
 *
 * Each one is an independently published npm package (`@cemoody/pi-crust-ext-*`).
 * When `pi-crust` is installed alone (`npx pi-crust`) none of these are present
 * and pi-crust runs lean. When `pi-crust-full` is installed it pulls all four
 * in transitively, so they show up here and get auto-loaded as bundled
 * extensions — same UX as the old `extensions/` directory used to provide.
 *
 * Missing packages are silently skipped so a partial install (e.g. user opted
 * out of one extension) still works.
 */
function resolveOfficialExtensionPackages(): string[] {
  const officialPackages = [
    "@cemoody/pi-crust-ext-schedule",
    "@cemoody/pi-crust-ext-branching",
    "@cemoody/pi-crust-ext-artifacts",
    "@cemoody/pi-crust-ext-presentations",
  ];
  const require = createRequire(import.meta.url);
  const resolved: string[] = [];
  for (const pkg of officialPackages) {
    try {
      const manifestPath = require.resolve(`${pkg}/package.json`);
      resolved.push(path.dirname(manifestPath));
    } catch {
      // Package not installed — lean install or user opted out. Skip silently.
    }
  }
  return resolved;
}

