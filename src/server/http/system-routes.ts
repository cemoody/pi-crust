import http from "node:http";
import os from "node:os";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { SerializedExtensionPackage } from "../../extensions/metadata.js";
import type { PrcExtensionRuntime } from "../../extensions/runtime.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { RealtimeGateway } from "../protocol/realtime-gateway.js";
import type { ClientEventLog, ClientEventStats } from "./system-routes/client-event-log.js";
import { CLIENT_EVENT_MAX_BYTES } from "./system-routes/client-event-log.js";

export { CLIENT_EVENT_MAX_BYTES } from "./system-routes/client-event-log.js";
export type { ClientEventLog, ClientEventStats } from "./system-routes/client-event-log.js";

export interface SystemRouteContext {
  readonly registry: SessionRegistry;
  readonly adapterKind: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly defaultCwd?: string;
  readonly clientEventLog?: ClientEventLog;
  readonly realtimeGateway?: RealtimeGateway;
  readonly ptyManager?: PtyManager;
  readonly gitSha?: string | (() => string);
  readonly piVersion?: string;
  readonly extensionPackages?: readonly SerializedExtensionPackage[];
  readonly extensionRuntime?: PrcExtensionRuntime;
  readonly authStorage?: AuthStorage;
}

export interface SystemRouteDependencies {
  readonly sendJson: (res: http.ServerResponse, status: number, data: unknown) => void;
  readonly resolveAppBranding: (context: Pick<SystemRouteContext, "extensionRuntime">) => Promise<{ readonly appName: string; readonly appIcon?: string }>;
}

/**
 * Dispatch observability and service-health routes. Session, extension, and
 * static UI routes deliberately stay outside this boundary, so this module is
 * the owned API surface for server operational state.
 */
export async function handleSystemRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: SystemRouteContext,
  dependencies: SystemRouteDependencies,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/models") {
    dependencies.sendJson(res, 200, await context.registry.listModels());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/realtime/stats") {
    dependencies.sendJson(res, 200, context.realtimeGateway?.stats() ?? { connections: 0 });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    const sessions = context.registry.getSessionHealthSnapshot();
    dependencies.sendJson(res, 200, {
      ok: true,
      adapter: context.adapterKind,
      projectRoot: context.projectRoot,
      sessionRoot: context.sessionRoot,
      defaultCwd: context.defaultCwd ?? process.cwd(),
      homeCwd: os.homedir(),
      terminalEnabled: Boolean(context.ptyManager),
      ...(await dependencies.resolveAppBranding(context)),
      gitSha: resolveContextGitSha(context.gitSha),
      piVersion: context.piVersion ?? "unknown",
      extensionPackages: context.extensionPackages ?? [],
      sessions: {
        total: sessions.total,
        healthy: sessions.healthy,
        broken: sessions.broken,
        ...(sessions.broken > 0 ? { brokenSessionIds: sessions.brokenSessionIds } : {}),
      },
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/client-event") {
    await handleClientEvent(req, res, context, dependencies.sendJson);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/client-event/stats") {
    const requestedMs = Number(url.searchParams.get("windowMs") ?? 5 * 60_000);
    const windowMs = Math.max(1_000, Math.min(60 * 60_000, Number.isFinite(requestedMs) ? requestedMs : 5 * 60_000));
    const stats = context.clientEventLog?.stats(windowMs) ?? emptyClientEventStats(windowMs);
    dependencies.sendJson(res, 200, stats);
    return true;
  }
  return false;
}

function resolveContextGitSha(value: string | (() => string) | undefined): string {
  if (typeof value === "function") {
    try { return value(); } catch { return "unknown"; }
  }
  return typeof value === "string" && value.trim() ? value : "unknown";
}

function emptyClientEventStats(windowMs: number): ClientEventStats {
  return { windowMs, total: 0, bufferDropped: 0, byKind: {}, byApiErrorStatus: {}, topSessions: [], topApiErrorPaths: [] };
}

async function handleClientEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: Pick<SystemRouteContext, "clientEventLog">,
  sendJson: SystemRouteDependencies["sendJson"],
): Promise<void> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    received += buffer.length;
    if (received > CLIENT_EVENT_MAX_BYTES) {
      sendJson(res, 413, { error: "client-event payload too large" });
      return;
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    parsed = text ? JSON.parse(text) : {};
  } catch {
    sendJson(res, 400, { error: "client-event payload was not JSON" });
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJson(res, 400, { error: "client-event payload must be a JSON object" });
    return;
  }
  await context.clientEventLog?.append({
    serverTs: Date.now(),
    remoteAddress: req.socket.remoteAddress ?? null,
    ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    ...(parsed as Record<string, unknown>),
  });
  sendJson(res, 204, undefined);
}
