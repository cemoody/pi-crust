import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { OAuthLoginError, OAuthLoginManager } from "./auth/oauth-login-manager.js";
import { MockPiAdapter } from "./pi/mock-pi-adapter.js";
import { SdkPiAdapter } from "./pi/sdk-pi-adapter.js";
import { contentTextAndThinking, PiRpcAdapter } from "./pi/pirpc-pi-adapter.js";
import { MAX_PROMPT_CHARS } from "../shared/limits.js";
import type { ExtensionUiResponse } from "../shared/protocol.js";
import { parseSlashCommand } from "../shared/slash-command-parser.js";
import type { PromptAttachment, SessionListItem, SessionMessage } from "./pi/types.js";
import { PathPolicy, isPathWithinRoot } from "./security/path-policy.js";
import { resolveGitSha, createLiveGitSha } from "./git-sha.js";
import { resolvePiVersion } from "./pi-version.js";
import { SessionRegistry, type RegisteredSession } from "./session/session-registry.js";
import { SessionSearchService } from "./session/session-search-service.js";
import { deferJsonlOffsetIndexBuild, readIndexedJsonlTail } from "./session/session-jsonl-offset-index.js";
import { attachRealtimeGateway } from "./protocol/realtime-gateway.js";
import { PtyManager } from "./pty/pty-manager.js";
import { createNodePtySpawner } from "./pty/node-pty-spawner.js";

/**
 * Whether the browser Terminal feature is enabled. It is OPT-IN: the base
 * `pi-crust` distribution ships it dormant, and only `pi-crust-full` enables it
 * (its bin.mjs sets PI_CRUST_ENABLE_TERMINAL=1). Accepts 1/true/yes/on.
 */
export function isTerminalFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PI_CRUST_ENABLE_TERMINAL;
  if (raw == null) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
import { WorkerRegistry } from "./session/worker-registry.js";
import type { PrcExtensionHost } from "../extensions/registry.js";
import { defaultPrcConfigDir } from "../extensions/bootstrap.js";
import { serializeExtensions, serializeExtensionPackages, readLockfileGitShas, type SerializedExtensionPackage } from "../extensions/metadata.js";
import { installExtensionPackage, readPrcSettings, removeExtensionPackage, setExtensionEnabled, writePrcSettings, type PackageCommandRunner, type PrcAppBrandingSettings, type PrcSettings } from "../extensions/packages.js";
import { checkExtensionUpdates } from "../extensions/update-service.js";
import { updateSource } from "../extensions/update-apply.js";
import type { CommandOutputRunner } from "../extensions/update-check.js";
import { createPrcExtensionRuntime, type PrcExtensionRuntime } from "../extensions/runtime.js";
import { defaultArtifactFileRoots, resolveArtifactFile, resolveArtifactFileForWrite, streamArtifactFile, writeArtifactFileContent } from "./artifact-file.js";
import { SessionTimelineMetadataStore, type SessionTimelineMetadata } from "./session/session-timeline-metadata-store.js";
import { TranscriptTailWorkerPool } from "./session/transcript-tail-worker-pool.js";
import { readSessionMessagesTail as readSessionMessagesTailFromWorkerModule } from "./session/transcript-tail-reader.js";
import { findSessionMessageBySyntheticId, lookupSessionMessage } from "./http-api-message-lookup.js";
import { hydrateTranscriptSidecars } from "./pi/transcript-sidecars.js";
import { SessionTranscriptPageCache } from "./session-transcript-page-cache.js";
import { payloadRefMeta, readPayloadRef } from "./pi/extensions/payload-budget.js";
import { createClientEventLog } from "./http/system-routes/client-event-log.js";
import { handleSystemRoute, type ClientEventLog } from "./http/system-routes.js";

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
  /** Version string of the `pi` binary the rpc workers spawn ("0.78.0"),
   *  surfaced on /api/health for the help dialog. Snapshotted at startup
   *  because the running binary can't change without an API restart. */
  readonly piVersion?: string;
  /** Per-package version/SHA of each loaded extension, snapshotted at startup.
   *  Surfaced on /api/health alongside the build SHAs. */
  readonly extensionPackages?: readonly SerializedExtensionPackage[];
  /** Test-first seed for pi-crust server extensions. Extension routes are mounted
   * under /api/extensions/:extensionId/* and are intentionally passed in by
   * tests/harnesses until package discovery is wired into the default server.
   */
  readonly extensions?: PrcExtensionHost;
  readonly extensionRuntime?: PrcExtensionRuntime;
  /** Test seam: capture-stdout runner used by the update-check endpoint. */
  readonly extensionUpdateCheckRunner?: CommandOutputRunner;
  /** Test seam: command runner used by the update-apply endpoint. */
  readonly extensionUpdateApplyRunner?: PackageCommandRunner;
  readonly authStorage?: AuthStorage;
  /** Optional PTY manager enabling the browser Terminal tab. */
  readonly ptyManager?: import("./pty/pty-manager.js").PtyManager;
  /** Optional bounded tail-reader pool; injectable for isolated server tests. */
  readonly transcriptTailWorkers?: TranscriptTailWorkerPool;
  /**
   * Optional callback invoked once the server context exists, handing back a
   * session resolver that performs the SAME lazy cold-session open + alias
   * resolution as the HTTP routes (getOrOpenSession). The extension host's
   * `ctx.sessions.get(...)` is wired to this so extension-served routes (e.g.
   * the artifacts route GET /api/sessions/:id/artifacts/:file) can resolve a
   * session's cwd even when it is only listed (cold) and not yet loaded into
   * the in-memory registry. Without it, `ctx.sessions.get` is undefined and
   * the artifact route fails with 500 "session has no cwd".
   */
  readonly bindSessionResolver?: (resolve: (sessionId: string) => Promise<RegisteredSession>) => void;
  /** Override the derived index location. Intended for tests and advanced local deployments. */
  readonly sessionSearchDatabasePath?: string;
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
  /** Coalesced, LRU-cached pages for /messages?limit=&before= JSONL reads. */
  readonly transcriptPageCache: SessionTranscriptPageCache;
  /**
   * Active SSE streams keyed by `tabSessionId`. When a new SSE arrives for a
   * tab that already has one open, the previous one is closed so the browser
   * promptly frees the underlying TCP connection. Without this, leaked
   * streams (from session-switching, soft reloads, etc.) accumulate against
   * Chrome's 6-per-origin HTTP/1.1 connection budget and the next request
   * from the page stalls indefinitely.
   */
  readonly activeSseByTab: Map<string, http.ServerResponse>;
  /** Set after the realtime gateway is mounted; exposes live connection stats. */
  realtimeGateway?: import("./protocol/realtime-gateway.js").RealtimeGateway;
  /**
   * Lazily-created driver for the interactive OAuth ("subscription") login
   * flow. Held on the context so a multi-request flow uses one AuthStorage
   * instance and one in-flight login() promise.
   */
  oauthLoginManager?: OAuthLoginManager;
  readonly sessionSearch: SessionSearchService;
  /** Bounded off-thread JSONL parsing for heavyweight transcript tails. */
  readonly transcriptTailWorkers: TranscriptTailWorkerPool;
  /** Bounded, persisted timeline metadata for session cards. */
  readonly timelineMetadata: SessionTimelineMetadataStore;
}

export { CLIENT_EVENT_MAX_BYTES } from "./http/system-routes.js";
export { CLIENT_EVENT_RING_CAPACITY, summarizeClientEventRing } from "./http/system-routes/client-event-log.js";
export const JSON_BODY_MAX_BYTES = 16 * 1024 * 1024;

export type { ClientEventStats } from "./http/system-routes.js";


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

function getAuthStorage(context: Pick<HttpApiServerContext, "authStorage">): AuthStorage {
  return context.authStorage ?? AuthStorage.create();
}

/**
 * One OAuth login flow spans several HTTP requests (start, poll, submit,
 * cancel), so it needs a stable AuthStorage instance and a single in-flight
 * login() promise. Cache the manager on the context the first time it's asked
 * for. Tests that inject an in-memory AuthStorage get a manager bound to it.
 */
function getOAuthLoginManager(context: HttpApiServerContext): OAuthLoginManager {
  if (!context.oauthLoginManager) {
    context.oauthLoginManager = new OAuthLoginManager(getAuthStorage(context));
  }
  return context.oauthLoginManager;
}

// Mirror of @earendil-works/pi-coding-agent's BUILT_IN_PROVIDER_DISPLAY_NAMES.
// Re-declared here because the package doesn't export it from its root entry
// and importing a dist subpath would be brittle across versions. Kept in sync
// so /api/auth/providers shows the same friendly names as the Pi TUI.
const BUILT_IN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai-responses": "Azure OpenAI Responses",
  cerebras: "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  google: "Google Gemini",
  "google-vertex": "Google Vertex AI",
  groq: "Groq",
  huggingface: "Hugging Face",
  "kimi-coding": "Kimi For Coding",
  mistral: "Mistral",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (China)",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI (China)",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  together: "Together AI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  zai: "ZAI",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-cn": "Xiaomi MiMo Token Plan (China)",
  "xiaomi-token-plan-ams": "Xiaomi MiMo Token Plan (Amsterdam)",
  "xiaomi-token-plan-sgp": "Xiaomi MiMo Token Plan (Singapore)",
};

const BUILT_IN_MODEL_PROVIDERS: ReadonlySet<string> = new Set(getBuiltinProviders());

/**
 * Mirror of the TUI's `isApiKeyLoginProvider`: a provider supports API-key
 * login when it has a known display name, OR it's an unknown provider that
 * isn't an OAuth-only provider. Built-in model providers without a display
 * name (rare) are excluded so we don't offer key entry for providers that
 * have no sensible API-key path.
 */
function isApiKeyLoginProvider(provider: string, oauthIds: ReadonlySet<string>): boolean {
  if (BUILT_IN_PROVIDER_DISPLAY_NAMES[provider]) return true;
  if (BUILT_IN_MODEL_PROVIDERS.has(provider)) return false;
  return !oauthIds.has(provider);
}

function apiKeyDisplayName(provider: string): string {
  return BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

async function authProviderInfo(
  context: Pick<HttpApiServerContext, "authStorage" | "registry">,
  provider: string,
  options: { readonly oauthLogin: boolean; readonly apiKeyLogin: boolean; readonly oauthName?: string; readonly usesCallbackServer?: boolean },
) {
  const storage = getAuthStorage(context);
  const status = storage.getAuthStatus(provider);
  const credential = storage.get(provider);
  return {
    provider,
    configured: status.configured,
    name: apiKeyDisplayName(provider),
    oauthLogin: options.oauthLogin,
    apiKeyLogin: options.apiKeyLogin,
    ...(options.oauthName ? { oauthName: options.oauthName } : {}),
    ...(options.usesCallbackServer ? { usesCallbackServer: true } : {}),
    ...(credential ? { credentialType: credential.type } : {}),
    ...(status.source ? { source: status.source } : {}),
    ...(status.label ? { label: status.label } : {}),
  };
}

async function singleAuthProviderInfo(context: HttpApiServerContext, provider: string) {
  const oauthProviders = getOAuthLoginManager(context).oauthProviders();
  const oauthIds = new Set(oauthProviders.map((entry) => entry.id));
  const oauth = oauthProviders.find((entry) => entry.id === provider);
  return authProviderInfo(context, provider, {
    oauthLogin: !!oauth,
    apiKeyLogin: isApiKeyLoginProvider(provider, oauthIds),
    ...(oauth ? { oauthName: oauth.name, usesCallbackServer: oauth.usesCallbackServer } : {}),
  });
}

async function listAuthProviders(context: HttpApiServerContext) {
  const oauthProviders = getOAuthLoginManager(context).oauthProviders();
  const oauthById = new Map(oauthProviders.map((provider) => [provider.id, provider] as const));
  const oauthIds = new Set(oauthProviders.map((provider) => provider.id));
  const providers = new Set<string>();
  for (const model of await context.registry.listModels()) providers.add(model.provider);
  for (const provider of getAuthStorage(context).list()) providers.add(provider);
  for (const provider of oauthProviders) providers.add(provider.id);
  return Promise.all(
    [...providers].sort().map((provider) => {
      const oauth = oauthById.get(provider);
      return authProviderInfo(context, provider, {
        oauthLogin: !!oauth,
        apiKeyLogin: isApiKeyLoginProvider(provider, oauthIds),
        ...(oauth ? { oauthName: oauth.name, usesCallbackServer: oauth.usesCallbackServer } : {}),
      });
    }),
  );
}

/**
 * Routes under /api/auth/oauth/* that drive the interactive subscription
 * login flow. Mirrors the Pi TUI's `/login` OAuth dialog:
 *   POST   /api/auth/oauth/start          { provider }            -> flow snapshot
 *   GET    /api/auth/oauth/:flowId?cursor=N                        -> flow snapshot
 *   POST   /api/auth/oauth/:flowId/input  { requestId, value }    -> flow snapshot
 *   POST   /api/auth/oauth/:flowId/cancel                          -> flow snapshot
 */
async function handleOAuthLoginRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: HttpApiServerContext,
  url: URL,
): Promise<void> {
  const manager = getOAuthLoginManager(context);
  const rest = url.pathname.slice("/api/auth/oauth".length).replace(/^\//, "");
  const [segment, action] = rest.split("/");
  try {
    if (req.method === "POST" && (segment === "start" || segment === "")) {
      const body = await readJson(req) as { provider?: unknown };
      if (typeof body.provider !== "string" || body.provider.trim().length === 0) {
        return sendJson(res, 400, { error: "provider must be a non-empty string" });
      }
      return sendJson(res, 200, manager.start(body.provider.trim()));
    }
    if (!segment) return sendJson(res, 404, { error: "not found" });
    if (req.method === "GET" && !action) {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      return sendJson(res, 200, manager.poll(segment, Number.isFinite(cursor) ? cursor : 0));
    }
    if (req.method === "POST" && action === "input") {
      const body = await readJson(req) as { requestId?: unknown; value?: unknown };
      if (typeof body.requestId !== "string" || body.requestId.length === 0) {
        return sendJson(res, 400, { error: "requestId must be a non-empty string" });
      }
      const value = typeof body.value === "string" ? body.value : "";
      return sendJson(res, 200, manager.submit(segment, body.requestId, value));
    }
    if (req.method === "POST" && action === "cancel") {
      return sendJson(res, 200, manager.cancel(segment));
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    if (error instanceof OAuthLoginError) return sendJson(res, 400, { error: error.message });
    throw error;
  }
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

/**
 * Builds the PrcSessionsApi handed to the extension host.
 *
 * - `getRegistry` is a getter (not the registry itself) because the extension
 *   host is constructed before the SessionRegistry exists; the returned API's
 *   methods only invoke it at request time, by which point it's ready.
 * - `resolveSession` lazily opens cold sessions (parity with getOrOpenSession),
 *   so extension routes can resolve a session's cwd for sessions that were
 *   merely listed and never loaded into the registry's in-memory map. Without
 *   this, the artifacts route's `ctx.sessions.get(...)` could not find a cwd
 *   and returned 500 "session has no cwd".
 */
export function createExtensionSessionApi(
  getRegistry: () => SessionRegistry,
  resolveSession: (sessionId: string) => Promise<RegisteredSession> = async (sessionId) => getRegistry().getSession(sessionId),
) {
  return {
    create: async (input: { readonly cwd: string; readonly sessionName?: string; readonly subagent?: boolean; readonly hiddenFromList?: boolean }) => {
      const session = await getRegistry().createSession(input);
      const state = await session.handle.getState();
      return toSessionCard(state);
    },
    prompt: async (sessionId: string, prompt: string) => {
      await getRegistry().prompt(sessionId, prompt);
    },
    createAndPrompt: async (input: { readonly cwd: string; readonly sessionName?: string; readonly prompt: string; readonly subagent?: boolean; readonly hiddenFromList?: boolean }) => {
      const session = await getRegistry().createSession(input);
      await getRegistry().prompt(session.id, input.prompt);
      const state = await session.handle.getState();
      return toSessionCard(state);
    },
    get: async (sessionId: string) => {
      const session = await resolveSession(sessionId);
      const state = await session.handle.getState();
      return toSessionCard(state);
    },
    // Branching routes (fork-messages/fork/clone) resolve the source session
    // through the SAME lazy cold-open resolver as get(), so they work for a
    // session that was merely listed and never loaded into the in-memory map.
    // resolveSession opens the cold handle (registering it as hot) before the
    // registry method re-resolves it by id; an unknown id throws
    // SessionNotFoundError (-> 404) instead of the registry's generic
    // "Unknown session" Error (-> 500). Mirrors the artifacts cold-open fix
    // from PR #205, which only covered get().
    getForkMessages: async (sessionId: string) => {
      const session = await resolveSession(sessionId);
      return getRegistry().getForkMessages(session.id);
    },
    forkSession: async (sessionId: string, entryId: string) => {
      const source = await resolveSession(sessionId);
      const { result, session } = await getRegistry().forkSession(source.id, entryId);
      return { ...result, session: toSessionCard(await session.handle.getState()) };
    },
    cloneSession: async (sessionId: string) => {
      const source = await resolveSession(sessionId);
      const { result, session } = await getRegistry().cloneSession(source.id);
      return { ...result, session: toSessionCard(await session.handle.getState()) };
    },
  };
}


export function createHttpApiServer(options: HttpApiServerOptions): http.Server {
  const context: HttpApiServerContext = {
    ...options,
    coldSessionFiles: new Map(),
    sessionAliases: new Map(),
    openingSessions: new Map(),
    transcriptPageCache: new SessionTranscriptPageCache((sessionFile, options) => context.transcriptTailWorkers.read(sessionFile, options)),
    activeSseByTab: new Map(),
    sessionSearch: new SessionSearchService({
      sessionRoot: options.sessionRoot,
      databasePath: options.sessionSearchDatabasePath ?? path.join(path.dirname(options.sessionRoot), ".pi-crust-session-search.sqlite"),
      includeSession: (cwd, sessionFile) => {
        try {
          options.registry.assertSearchableSession(cwd, sessionFile);
          return true;
        } catch {
          return false;
        }
      },
    }),
    transcriptTailWorkers: options.transcriptTailWorkers ?? new TranscriptTailWorkerPool(),
    timelineMetadata: new SessionTimelineMetadataStore(),
    ...(options.clientEventLogPath ? { clientEventLog: createClientEventLog(options.clientEventLogPath) } : {}),
  };
  const server = http.createServer((req, res) => {
    void handle(req, res, context).catch((error) => {
      if (error instanceof HttpBodyError) return sendJson(res, error.status, { error: error.message });
      // A genuinely unknown session must surface as 404, never a 500 stack
      // leak. This covers extension-served routes (e.g. branching
      // fork-messages/fork/clone) whose handlers call ctx.sessions.* and let
      // the resolver's not-found error propagate.
      if (error instanceof SessionNotFoundError) return sendJson(res, error.status, { error: error.message });
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.once("close", () => {
    context.transcriptPageCache.clear();
    context.sessionSearch.close();
    // Do not leave parser workers keeping test processes or a stopped API alive.
    void context.transcriptTailWorkers.close();
    void context.timelineMetadata.flush();
  });
  // Index only after the agent settles: Pi persists JSONL incrementally while
  // streaming, and search must never expose a partial assistant response.
  const unsubscribeSearchIndexing = context.registry.subscribeAll((session, event) => {
    if (event.type === "agent_start") context.sessionSearch.markSessionActive(session.sessionFile);
    if (event.type === "agent_end") context.sessionSearch.markSessionSettled(session.sessionFile);
  });
  server.once("close", unsubscribeSearchIndexing);
  // Mount the multiplexed Socket.IO realtime gateway on the same server. It
  // claims only its own `/socket.io/` path + the WS upgrade for that path, so
  // REST and the legacy SSE stream keep working untouched. Cold-session open
  // parity is provided by reusing getOrOpenSession.
  // Realtime handlers contributed by extensions via ctx.server.realtime. We
  // resolve them LIVE per connection (not a boot-time snapshot) so an extension
  // installed/reloaded at runtime via the Settings UI is picked up by sockets
  // that connect afterwards — without this, `pty:open` (and any extension
  // realtime protocol) would silently time out until a server restart.
  context.realtimeGateway = attachRealtimeGateway({
    server,
    registry: context.registry,
    resolveSession: (sessionId) => getOrOpenSession(context, sessionId),
    ...(options.ptyManager ? { ptyManager: options.ptyManager } : {}),
    resolveConnectionHandlers: () =>
      getExtensionHost(context)
        ?.realtime.list()
        .map((registered) => registered.handler) ?? [],
  });
  // Hand the extension host a session resolver that lazy-opens cold sessions,
  // matching the HTTP routes. Extension-served routes (e.g. the artifacts
  // route) depend on this to resolve a session's cwd.
  options.bindSessionResolver?.((sessionId) => getOrOpenSession(context, sessionId));
  return server;
}

function createDefaultRegistry(
  adapterKind: string,
  sessionRoot: string,
  projectRoot: string,
  extraPiArgs: readonly string[] = [],
  getAppendSystemPrompt?: () => Promise<string | undefined>,
): SessionRegistry {
  const workerRegistry = new WorkerRegistry();
  return new SessionRegistry({
    adapter: adapterKind === "mock"
      ? new MockPiAdapter({ sessionRoot })
      : adapterKind === "pirpc"
        ? new PiRpcAdapter({
            sessionDir: sessionRoot,
            runtimeDir: workerRegistry.runtimeDir,
            extraArgs: extraPiArgs,
            ...(getAppendSystemPrompt ? { getAppendSystemPrompt } : {}),
          })
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
  const serverDefaultCwd = isPathWithinRoot(process.cwd(), projectRoot) ? process.cwd() : projectRoot;
  // Deferred wiring: the extension host is created before the registry (it
  // can't be — getPiExtensionArgs needs the host) and before the server
  // context (which owns the lazy cold-open resolver). We hand the host a
  // sessions API now, but its method bodies read these mutable holders at
  // request time, by which point both are initialized:
  //   - registryRef: the SessionRegistry (set right after the runtime).
  //   - resolveSessionForExtensions: the cold-open resolver, set by
  //     createHttpApiServer via bindSessionResolver. Until then we fall back
  //     to a plain (loaded-only) registry lookup.
  let registryRef: SessionRegistry | undefined;
  let resolveSessionForExtensions: ((sessionId: string) => Promise<RegisteredSession>) | undefined;
  const extensionSessionResolver = (sessionId: string): Promise<RegisteredSession> => {
    if (resolveSessionForExtensions) return resolveSessionForExtensions(sessionId);
    if (!registryRef) throw new Error("Session registry is not ready");
    return Promise.resolve(registryRef.getSession(sessionId));
  };
  const extensionRuntime = await createPrcExtensionRuntime({
    configDir: defaultPrcConfigDir(process.env),
    cwd: projectRoot,
    env: process.env,
    dataDir: path.resolve(process.env.PI_CRUST_DATA_DIR ?? path.join(os.homedir(), ".pi-crust", "data")),
    bundledPackagePaths: resolveOfficialExtensionPackages(),
    sessions: createExtensionSessionApi(() => {
      if (!registryRef) throw new Error("Session registry is not ready");
      return registryRef;
    }, extensionSessionResolver),
  });
  if (extensionRuntime.current.diagnostics.length > 0) {
    for (const diagnostic of extensionRuntime.current.diagnostics) console.warn(`[extensions] ${diagnostic.extensionId}: ${diagnostic.message}`);
  }
  const registry = createDefaultRegistry(
    adapterKind,
    sessionRoot,
    projectRoot,
    extensionRuntime.getPiExtensionArgs(),
    // Lazily read the workspace-wide system prompt so Settings edits apply to
    // the next spawned session without an API restart.
    async () => {
      try {
        const settings = await readPrcSettings(extensionRuntime.configDir);
        const prompt = settings.globalSystemPrompt;
        return typeof prompt === "string" && prompt.trim().length > 0 ? prompt : undefined;
      } catch {
        return undefined;
      }
    },
  );
  registryRef = registry;
  const clientEventLogPath = process.env.PI_CRUST_CLIENT_EVENT_LOG
    ?? path.resolve(process.cwd(), "logs", "client-events.jsonl");
  // Live SHA: recomputed when .git/HEAD changes so /api/health doesn't lie
  // about the build after a `git pull` lands new commits.
  const gitSha = createLiveGitSha({ cwd: process.cwd(), env: process.env });
  // Startup snapshots for the help dialog: the running pi version (probed from
  // the same binary the rpc adapter spawns) and the loaded extensions'
  // versions/SHAs. Both are fixed for the process lifetime, so reading them
  // once here keeps the polled /api/health endpoint free of fs/exec work.
  const piVersion = resolvePiVersion({ env: process.env, cwd: process.cwd() });
  const lockfileGitShas = readLockfileGitShas(process.cwd());
  const extensionPackages = serializeExtensionPackages(extensionRuntime.current, {
    gitShaForPackage: (name) => (name ? lockfileGitShas.get(name) : undefined),
  });
  // Browser Terminal: a PTY manager confined to the same project root the
  // session registry already trusts. This is an OPT-IN feature that the base
  // `pi-crust` distribution does NOT enable — only `pi-crust-full` turns it on
  // (its bin.mjs sets PI_CRUST_ENABLE_TERMINAL=1). Also disabled (no terminal)
  // if node-pty fails to load on this platform.
  let ptyManager: PtyManager | undefined;
  if (isTerminalFeatureEnabled(process.env)) {
    try {
      const ptyPolicy = new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] });
      ptyManager = new PtyManager({ spawn: createNodePtySpawner({ pathPolicy: ptyPolicy }) });
    } catch (err) {
      console.warn(`[terminal] disabled: ${err instanceof Error ? err.message : err}`);
    }
  }
  const server = createHttpApiServer({
    registry,
    adapterKind,
    projectRoot,
    sessionRoot,
    defaultCwd: serverDefaultCwd,
    clientEventLogPath,
    gitSha,
    piVersion,
    extensionPackages,
    extensionRuntime,
    ...(ptyManager ? { ptyManager } : {}),
    bindSessionResolver: (resolve) => { resolveSessionForExtensions = resolve; },
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

  if (await handleSystemRoute(req, res, url, context, {
    sendJson,
    resolveAppBranding,
  })) return;

  if (req.method === "GET" && url.pathname === "/api/extensions") {
    return sendJson(res, 200, serializeExtensions(getExtensionHost(context)));
  }

  if (req.method === "GET" && url.pathname === "/api/auth/providers") {
    return sendJson(res, 200, { providers: await listAuthProviders(context) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req) as { provider?: unknown; apiKey?: unknown };
    if (typeof body.provider !== "string" || body.provider.trim().length === 0) {
      return sendJson(res, 400, { error: "provider must be a non-empty string" });
    }
    if (typeof body.apiKey !== "string" || body.apiKey.trim().length === 0) {
      return sendJson(res, 400, { error: "apiKey must be a non-empty string. For subscription login use POST /api/auth/oauth/start instead." });
    }
    const provider = body.provider.trim();
    getAuthStorage(context).set(provider, { type: "api_key", key: body.apiKey.trim() });
    return sendJson(res, 200, { provider: await singleAuthProviderInfo(context, provider) });
  }

  if (url.pathname === "/api/auth/oauth" || url.pathname.startsWith("/api/auth/oauth/")) {
    return handleOAuthLoginRoute(req, res, context, url);
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const body = await readJson(req) as { provider?: unknown };
    if (typeof body.provider !== "string" || body.provider.trim().length === 0) {
      return sendJson(res, 400, { error: "provider must be a non-empty string" });
    }
    const provider = body.provider.trim();
    getAuthStorage(context).logout(provider);
    return sendJson(res, 200, { provider: await singleAuthProviderInfo(context, provider) });
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

  if (req.method === "GET" && url.pathname === "/api/extensions/updates") {
    const runtime = requireExtensionRuntime(context, res, "extension update checks");
    if (!runtime) return;
    const settings = await readPrcSettings(runtime.configDir);
    const force = url.searchParams.get("force") === "1";
    const updates = await checkExtensionUpdates(settings, {
      configDir: runtime.configDir,
      force,
      ...(context.extensionUpdateCheckRunner ? { runner: context.extensionUpdateCheckRunner } : {}),
    });
    return sendJson(res, 200, { updates });
  }

  if (req.method === "POST" && url.pathname === "/api/extensions/packages/update") {
    const runtime = requireExtensionRuntime(context, res, "extension package updates");
    if (!runtime) return;
    const body = await readJson(req) as { source?: string };
    if (!body.source) return sendJson(res, 400, { error: "source is required" });
    const source = body.source;
    let applyResult: Awaited<ReturnType<typeof updateSource>>;
    try {
      applyResult = await updateSource(source, {
        configDir: runtime.configDir,
        cwd: runtime.cwd,
        ...(context.extensionUpdateApplyRunner ? { runner: context.extensionUpdateApplyRunner } : {}),
      });
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    if (!applyResult.updated) {
      return sendJson(res, 200, { ...applyResult, applied: false, diagnostics: [], extensions: serializeExtensions(runtime.current) });
    }
    const reload = await runtime.reload();
    const settings = await readPrcSettings(runtime.configDir);
    return sendJson(res, reload.applied ? 200 : 400, { ...applyResult, settings, ...reload, extensions: serializeExtensions(runtime.current) });
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

  if (req.method === "GET" && url.pathname === "/api/sessions/search") {
    const query = url.searchParams.get("q") ?? "";
    // Number(null) is 0, which silently collapsed every normal browser query
    // to one result through SessionSearchService's minimum-limit clamp. Only
    // parse an explicitly supplied non-empty query parameter.
    const rawLimit = url.searchParams.get("limit");
    const parsedLimit = rawLimit === null || rawLimit.trim() === "" ? undefined : Number(rawLimit);
    const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
    const includeSubagents = url.searchParams.get("includeSubagents") === "true";
    return sendJson(res, 200, await context.sessionSearch.search(query, {
      ...(url.searchParams.get("cwd") ? { cwd: url.searchParams.get("cwd")! } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(includeSubagents ? { includeSubagents: true, includeHidden: true } : {}),
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const includeSubagents = url.searchParams.get("includeSubagents") === "true";
    return sendJson(res, 200, await dedupedListSessionCards(context, cwd, { includeSubagents, includeHidden: includeSubagents }));
  }

  if (req.method === "GET" && url.pathname === "/api/sessions/statuses") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const includeSubagents = url.searchParams.get("includeSubagents") === "true";
    return sendJson(res, 200, await dedupedListSessionCards(context, cwd, { includeSubagents, includeHidden: includeSubagents }));
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

  // Write edited content back to an on-disk artifact file (markdown/text
  // only). Mirrors the GET allow-list policy and additionally restricts the
  // target to editable text extensions so an inline edit can never clobber a
  // binary artifact. The file must already exist — we never create new files.
  if (req.method === "PUT" && url.pathname === "/api/artifact-file") {
    const candidate = url.searchParams.get("path");
    if (!candidate) return sendJson(res, 400, { error: "path query parameter is required" });
    const body = await readJson(req) as { content?: unknown };
    if (typeof body.content !== "string") {
      return sendJson(res, 400, { error: "content (string) is required" });
    }
    const result = await resolveArtifactFileForWrite(candidate, {
      allowedRoots: defaultArtifactFileRoots([
        context.projectRoot,
        context.sessionRoot,
        ...(context.defaultCwd ? [context.defaultCwd] : []),
      ]),
    });
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    const { size } = await writeArtifactFileContent(result.resolution, body.content);
    return sendJson(res, 200, { ok: true, path: result.resolution.absPath, size });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req) as { cwd?: string; sessionName?: string; subagent?: boolean; hiddenFromList?: boolean };
    if (!body.cwd) return sendJson(res, 400, { error: "cwd is required" });
    const created = await context.registry.createSession({
      cwd: body.cwd,
      ...(body.sessionName ? { sessionName: body.sessionName } : {}),
      ...(body.subagent === true ? { subagent: true } : {}),
      ...(body.hiddenFromList === true || body.subagent === true ? { hiddenFromList: true } : {}),
    });
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

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/((?:messages(?:\/[^/]+\/(?:images\/\d+|details|tool-output|artifact))?)|prompt|bash|abort|compact|reload|rename|delete|model|state|events|extension-ui-response|commands|pi-command))?$/);
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

  if (req.method === "GET" && action === "commands") {
    const session = await getOrOpenSession(context, sessionId);
    const commands = await context.registry.getCommands(session.id);
    return sendJson(res, 200, { commands });
  }

  if (req.method === "GET" && action === "messages") {
    const session = await getOrOpenSession(context, sessionId);
    const limitRaw = url.searchParams.get("limit");
    const beforeRaw = url.searchParams.get("before");
    const afterRaw = url.searchParams.get("after");
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Number(limitRaw), MAX_MESSAGES_LIMIT) : undefined;
    const before = beforeRaw && /^-?\d+$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
    const after = afterRaw && /^-?\d+$/.test(afterRaw) ? Number(afterRaw) : undefined;
    if (afterRaw !== null && after === undefined) return sendJson(res, 400, { error: "after must be a numeric message timestamp" });
    if (before !== undefined && after !== undefined) return sendJson(res, 400, { error: "before and after cannot be combined" });
    let messages: readonly SessionMessage[];
    if (after !== undefined) {
      // Reconnect catch-up is deliberately cursor based: the dashboard sends
      // the timestamp of its newest persisted row and receives only records
      // appended after it. Do not turn this into another tail-window fetch —
      // on a long mobile transcript that would repeatedly re-download the
      // same 80-message window after every background resume.
      //
      // Validate the boundary rather than silently treating an unknown cursor
      // as the beginning/end. A rewritten/truncated transcript must make the
      // client take its bounded tail-refresh fallback; otherwise it could
      // append an unrelated suffix to stale history.
      const all = await session.handle.getMessages();
      const cursorIndexes = all.flatMap((message, index) => message.timestamp === after ? [index] : []);
      // Timestamp is intentionally the portable, back-compatible cursor. It
      // cannot safely distinguish siblings created in the same millisecond;
      // reject that ambiguous boundary rather than skip a sibling and let the
      // dashboard take its bounded full-tail fallback.
      if (cursorIndexes.length !== 1) return sendJson(res, 409, { error: "message cursor is no longer available" });
      messages = all.slice(cursorIndexes[0]! + 1);
    } else if (limit !== undefined) {
      // Tail-window query: read only the trailing chunk of the session file
      // directly so a huge transcript doesn't have to be slurped + parsed in
      // full. Falls back to the adapter if a tail-read isn't possible (e.g.
      // session file doesn't exist on disk yet).
      // Cache/coalesce identical file-version pages first. The cache reader
      // delegates misses to the bounded worker pool, preserving both optimizations.
      const tail = await context.transcriptPageCache.get({
        sessionId: session.id,
        sessionFile: session.sessionFile,
        limit,
        ...(before === undefined ? {} : { before }),
      });
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

  // Shared by the /messages/:msgid/{images,details,tool-output,artifact}
  // routes below: open the session and find one message by id.
  const lookupMessage = (id: string, messageId: string) => lookupSessionMessageForHttpRoute(context, id, messageId);

  // Lazy fetch of inline image bytes that we strip from /messages payloads
  // to keep the timeline JSON small. Image URLs are issued by
  // toDashboardMessages; this route resolves them back to raw bytes.
  const imageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/(\d+)$/);
  if (req.method === "GET" && imageMatch) {
    const message = await lookupMessage(decodeURIComponent(imageMatch[1]!), decodeURIComponent(imageMatch[2]!));
    const image = messageImageAt(message, Number(imageMatch[3]!));
    if (!image) return sendJson(res, 404, { error: "image not found" });
    const externalized = payloadRefMeta(image.payloadRef);
    const encoded = externalized
      ? await readPayloadRef({ cwd: (await getOrOpenSession(context, decodeURIComponent(imageMatch[1]!))).cwd, sessionId: decodeURIComponent(imageMatch[1]!) }, image.payloadRef)
      : image.data;
    if (encoded === undefined) return sendJson(res, 404, { error: "externalized image payload not found" });
    const bytes = Buffer.from(encoded, "base64");
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
    const message = await lookupMessage(decodeURIComponent(detailsMatch[1]!), decodeURIComponent(detailsMatch[2]!));
    if (!message?.details) return sendJson(res, 404, { error: "details not found" });
    const ref = payloadRefMeta(message.details.payloadRef);
    const externalized = ref
      ? await readPayloadRef({ cwd: (await getOrOpenSession(context, decodeURIComponent(detailsMatch[1]!))).cwd, sessionId: decodeURIComponent(detailsMatch[1]!) }, message.details.payloadRef)
      : undefined;
    if (ref && externalized === undefined) return sendJson(res, 404, { error: "externalized details payload not found" });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    });
    res.end(externalized ?? JSON.stringify(message.details));
    return;
  }

  // Lazy fetch of full tool output that we truncate in /messages payloads.
  const toolOutputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/tool-output$/);
  if (req.method === "GET" && toolOutputMatch) {
    const id = decodeURIComponent(toolOutputMatch[1]!);
    const message = await lookupMessage(id, decodeURIComponent(toolOutputMatch[2]!));
    if (!message?.tool) return sendJson(res, 404, { error: "tool output not found" });
    const output = payloadRefMeta(message.tool.outputPayloadRef)
      ? await readPayloadRef({ cwd: (await getOrOpenSession(context, id)).cwd, sessionId: id }, message.tool.outputPayloadRef)
      : message.tool.output;
    if (output === undefined) return sendJson(res, 404, { error: "externalized tool output not found" });
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    });
    res.end(output);
    return;
  }

  // Lazy fetch of full tool artifacts (slides, rich HTML, large JSON specs)
  // that we strip from /messages payloads. Unlike the timeline bootstrap
  // response, this endpoint intentionally returns the full artifact so the UI
  // can render the card inline after the initial page becomes interactive.
  const toolArtifactMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/artifact$/);
  if (req.method === "GET" && toolArtifactMatch) {
    const id = decodeURIComponent(toolArtifactMatch[1]!);
    const message = await lookupMessage(id, decodeURIComponent(toolArtifactMatch[2]!));
    if (!message?.tool?.artifact) return sendJson(res, 404, { error: "tool artifact not found" });
    let artifact: unknown = message.tool.artifact;
    const ref = artifact && typeof artifact === "object" ? payloadRefMeta((artifact as Record<string, unknown>).payloadRef) : undefined;
    if (ref) {
      const raw = await readPayloadRef({ cwd: (await getOrOpenSession(context, id)).cwd, sessionId: id }, (artifact as Record<string, unknown>).payloadRef);
      if (raw === undefined) return sendJson(res, 404, { error: "externalized tool artifact not found" });
      try { artifact = (JSON.parse(raw) as Record<string, unknown>).piRemoteControlArtifact; } catch { return sendJson(res, 500, { error: "externalized tool artifact was corrupt" }); }
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    });
    res.end(JSON.stringify(artifact));
    return;
  }

  if (req.method === "GET" && (action === "state" || action === undefined)) {
    const session = await getOrOpenSession(context, sessionId);
    const metadata = await context.timelineMetadata.read(session.sessionFile);
    return sendJson(res, 200, toSessionCard(await session.handle.getState(), metadata));
  }

  if (req.method === "POST" && action === "pi-command") {
    const body = await readJson(req) as { text?: unknown };
    if (typeof body.text !== "string" || !parseSlashCommand(body.text)) return sendJson(res, 400, { error: "valid slash command text is required" });
    if (body.text.length > MAX_PROMPT_CHARS) return sendJson(res, 413, { error: `Message is ${body.text.length} characters. The limit is ${MAX_PROMPT_CHARS}.` });
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.runPiSlashCommand(session.id, body.text);
    return sendJson(res, 200, { ok: true });
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

  if (req.method === "POST" && action === "compact") {
    const body = await readJson(req) as { customInstructions?: unknown };
    const customInstructions = typeof body.customInstructions === "string" && body.customInstructions.trim()
      ? body.customInstructions.trim()
      : undefined;
    const session = await getOrOpenSession(context, sessionId);
    await context.registry.compact(session.id, customInstructions);
    const updatedSession = await getOrOpenSession(context, session.id);
    return sendJson(res, 200, toDashboardMessages(await updatedSession.handle.getMessages(), { sessionId: updatedSession.id }));
  }

  if (req.method === "POST" && action === "reload") {
    const session = await getOrOpenSession(context, sessionId);
    const reloaded = await context.registry.reloadSession(session.id);
    const metadata = await context.timelineMetadata.read(reloaded.sessionFile);
    return sendJson(res, 200, toSessionCard(await reloaded.handle.getState(), metadata));
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


async function getOrOpenSession(context: HttpApiServerContext, sessionId: string) {
  const resolvedId = resolveSessionAlias(context, sessionId);
  // Self-healing registry (Feature B): a registered handle whose detached
  // worker has died is unhealthy and every request through it would 500 with
  // "supervisor connection is closed" forever. Before serving a registered
  // handle, evict it if its worker is gone and fall through to a fresh
  // (re-spawning) open. See tests/scenarios/enoent-self-heals.test.ts.
  const candidateIds = resolvedId === sessionId ? [resolvedId] : [resolvedId, sessionId];
  for (const id of candidateIds) {
    if (!context.registry.hasSession(id)) continue;
    if (context.registry.isSessionHealthy(id)) return context.registry.getSession(id);
    await context.registry.evictDeadSession(id);
  }
  // De-duplicate concurrent opens for the same sessionId. See the
  // openingSessions docstring on HttpApiServerContext for why.
  const inflight = context.openingSessions.get(sessionId);
  if (inflight) return inflight;
  const sessionFile = context.coldSessionFiles.get(sessionId) ?? context.coldSessionFiles.get(resolvedId);
  if (!sessionFile) throw new SessionNotFoundError(sessionId);
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

async function lookupSessionMessageForHttpRoute(
  context: HttpApiServerContext,
  sessionId: string,
  syntheticMessageId: string,
): Promise<SessionMessage | undefined> {
  const session = await getOrOpenSession(context, sessionId);

  // Prefer the same file-tail path used by /messages?limit=N. It resolves ids
  // from tail-windowed responses and still works when a long-lived RPC handle
  // has gone stale/closed after the timeline was loaded.
  const tail = await context.transcriptTailWorkers.read(session.sessionFile, { limit: MAX_MESSAGES_LIMIT });
  const tailMatch = tail ? findSessionMessageBySyntheticId(tail, syntheticMessageId) : undefined;
  if (tailMatch) return tailMatch;

  try {
    return await lookupSessionMessage({ getOrOpenSession: async () => ({ handle: session.handle }) }, session.id, syntheticMessageId);
  } catch (error) {
    // If the hot handle is stale, do not turn a missing detail into a 500. The
    // caller will return the route's normal 404 for the requested subresource.
    const message = error instanceof Error ? error.message : String(error);
    if (/connection is closed|closed before frame|ECONNREFUSED|ENOENT/.test(message)) return undefined;
    throw error;
  }
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

async function dedupedListSessionCards(
  context: HttpApiServerContext,
  cwd?: string,
  options: { readonly includeSubagents?: boolean; readonly includeHidden?: boolean } = {},
) {
  const key = `${cwd ?? ""}|subagents:${options.includeSubagents === true ? "1" : "0"}|hidden:${options.includeHidden === true ? "1" : "0"}`;
  const now = Date.now();
  const cached = sessionsCardCache.get(key);
  if (cached && cached.expiresAt > now) return cached.cards;
  const inflight = sessionsCardInflight.get(key);
  if (inflight) return inflight;
  const pending = listSessionCards(context, cwd, options)
    .then((cards) => {
      sessionsCardCache.set(key, { expiresAt: Date.now() + LIST_SESSIONS_CACHE_TTL_MS, cards });
      return cards;
    })
    .finally(() => { sessionsCardInflight.delete(key); });
  sessionsCardInflight.set(key, pending);
  return pending;
}

async function listSessionCards(
  context: HttpApiServerContext,
  cwd?: string,
  options: { readonly includeSubagents?: boolean; readonly includeHidden?: boolean } = {},
) {
  // Search indexing deliberately reads complete transcripts. Do not make a
  // sidebar/status poll pay for that work: the production adapter has a
  // bounded head/tail lister, while the durable index (when already warm)
  // supplies richer metadata without another scan. Apart from avoiding a
  // multi-megabyte cold request, this keeps a newly written session visible
  // immediately instead of waiting for the asynchronous search index.
  const listed = await context.registry.listSessions(cwd, options);
  const indexedByFile = context.sessionSearch.getIndexedMetadata(listed.map((session) => session.sessionFile));
  const sessions = listed.map((session) => {
    const indexed = indexedByFile.get(session.sessionFile);
    if (!indexed) return session;
    return {
      ...session,
      ...(session.sessionName === undefined && indexed.sessionName ? { sessionName: indexed.sessionName } : {}),
      ...(session.createdAt === undefined ? { createdAt: indexed.createdAt } : {}),
      ...(session.lastUserActivity === undefined ? { lastUserActivity: indexed.lastUserActivity } : {}),
    };
  });
  for (const session of sessions) context.coldSessionFiles.set(session.id, session.sessionFile);
  return Promise.all(sessions.map((session) => sessionCardWithLiveState(context, session)));
}

async function sessionCardWithLiveState(
  context: HttpApiServerContext,
  session: SessionListItem,
) {
  const metadata: SessionTimelineMetadata = {
    createdAt: session.createdAt ?? null,
    lastUserActivity: session.lastUserActivity ?? null,
  };
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
          // SQLite's fully parsed title is authoritative over the hot worker
          // state, which can be stale after a restart/reattach.
          ...(session.sessionName ? { sessionName: session.sessionName } : {}),
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

function toSessionListCard(session: SessionListItem, metadata: SessionTimelineMetadata = { createdAt: null, lastUserActivity: null }) {
  return {
    id: session.id,
    cwd: session.cwd,
    sessionFile: session.sessionFile,
    sessionName: session.sessionName,
    subagent: session.subagent,
    hiddenFromList: session.hiddenFromList,
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
    subagent: state.subagent,
    hiddenFromList: state.hiddenFromList,
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
      // Tool rows use tool.output for their visible body. Do not duplicate a
      // multi-megabyte output through the generic message text field after
      // stripToolForTransport has made the tool payload lazy.
      text: message.role === "tool" && message.tool && sessionId
        ? stripToolTextForTransport(normalized.text)
        : normalized.text,
      provider: message.role === "assistant" ? "pi" : undefined,
      tool: message.tool ? stripToolForTransport(message.tool, sessionId, id, (images ?? []).length) : undefined,
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

function stripToolTextForTransport(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_INLINE_TOOL_OUTPUT_BYTES) return text;
  const halfWindow = Math.floor(MAX_INLINE_TOOL_OUTPUT_BYTES / 2);
  return `${text.slice(0, halfWindow)}\n\n…[tool output shown in the tool card; full text is lazy-loaded]…\n\n${text.slice(-halfWindow)}`;
}

function stripImagesForTransport(images: readonly { readonly data: string; readonly mimeType: string }[], sessionId: string, messageId: string) {
  return images.map((image, imageIndex) => ({
    mimeType: image.mimeType,
    url: `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/images/${imageIndex}`,
  }));
}

function messageImages(message: SessionMessage | undefined): readonly { readonly data: string; readonly mimeType: string; readonly payloadRef?: unknown }[] {
  if (!message) return [];
  const normalized = typeof message.content === "string" ? { images: [] as readonly { readonly data: string; readonly mimeType: string }[] } : contentTextAndThinking(message.content);
  const base = normalized.images.length > 0 ? normalized.images : (message.images ?? []);
  // Tool-result images (e.g. read of a PNG) live on message.tool.images and
  // are addressed by the /images/:index route after any message-level images.
  // The global index space must match stripToolForTransport's offset.
  const toolImages = message.tool?.images ?? [];
  return toolImages.length > 0 ? [...base, ...toolImages] : base;
}

function messageImageAt(message: SessionMessage | undefined, imageIndex: number) {
  if (!Number.isInteger(imageIndex) || imageIndex < 0) return undefined;
  return messageImages(message)[imageIndex];
}

function stripToolForTransport(
  tool: NonNullable<SessionMessage["tool"]>,
  sessionId: string | undefined,
  messageId: string,
  imageIndexOffset = 0,
) {
  const output = tool.output ?? "";
  const artifact = stripToolArtifactForTransport(tool.artifact, sessionId, messageId);
  const toolWithArtifact = artifact === tool.artifact ? tool : { ...tool, artifact };
  let result: Record<string, unknown> = { ...toolWithArtifact };
  const durableOutput = payloadRefMeta(tool.outputPayloadRef);
  if (sessionId && durableOutput) {
    const outputUrl = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/tool-output`;
    result = { ...result, outputTruncated: true, outputUrl, outputFullBytes: durableOutput.bytes };
  } else if (sessionId && Buffer.byteLength(output, "utf8") > MAX_INLINE_TOOL_OUTPUT_BYTES) {
    // Keep the first/last few KB inline so the UI still shows context without
    // a second round-trip. The exact midpoint is replaced with a marker that
    // includes the byte count and a URL to the full payload.
    const halfWindow = Math.floor(MAX_INLINE_TOOL_OUTPUT_BYTES / 2);
    const head = output.slice(0, halfWindow);
    const tail = output.slice(-halfWindow);
    const fullBytes = Buffer.byteLength(output, "utf8");
    const outputUrl = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/tool-output`;
    const truncated = `${head}\n\n…[${(fullBytes / 1024).toFixed(0)} KB truncated — full output at ${outputUrl}]…\n\n${tail}`;
    result = { ...result, output: truncated, outputTruncated: true, outputUrl, outputFullBytes: fullBytes };
  }
  // Tool images (e.g. read of a PNG) can be multi-MB base64; strip the bytes
  // and hand the pi-crust a URL into the /images/:index route (indexed after
  // any message-level images via imageIndexOffset). Without a sessionId we
  // can't mint URLs, so leave them inline for unit-test back-compat.
  if (sessionId && tool.images && tool.images.length > 0) {
    result = {
      ...result,
      images: tool.images.map((image, i) => ({
        mimeType: image.mimeType,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/images/${imageIndexOffset + i}`,
      })),
    };
  }
  return result;
}

function stripToolArtifactForTransport(artifact: unknown, sessionId: string | undefined, messageId: string): unknown {
  if (!artifact || typeof artifact !== "object") return artifact;
  const source = artifact as Record<string, unknown>;
  // Ingest-time guard externalized a tool artifact before it entered JSONL.
  // Preserve the existing lazy artifact UX even though the transport copy is
  // already small.
  if (payloadRefMeta(source.payloadRef)) {
    return {
      artifactTruncated: true,
      artifactFullBytes: payloadRefMeta(source.payloadRef)!.bytes,
      ...(typeof source.kind === "string" ? { kind: source.kind } : {}),
      ...(typeof source.title === "string" ? { title: source.title } : {}),
      ...(sessionId ? { artifactUrl: `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/artifact` } : {}),
    };
  }
  let serialised: string;
  try { serialised = JSON.stringify(artifact); } catch { return artifact; }
  const fullBytes = Buffer.byteLength(serialised, "utf8");
  if (fullBytes <= MAX_INLINE_TOOL_ARTIFACT_BYTES) return artifact;

  const preview: Record<string, unknown> = {
    artifactTruncated: true,
    artifactFullBytes: fullBytes,
    ...(sessionId ? { artifactUrl: `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/artifact` } : {}),
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
  const externalized = payloadRefMeta(details.payloadRef);
  if (externalized) {
    return {
      details: { detailsExternalized: true },
      detailsUrl: `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/details`,
      detailsTruncated: true,
      detailsFullBytes: externalized.bytes,
    };
  }
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

/** Backward-compatible test helper; production message pages use the bounded
 * worker pool (and page cache) above. */
export async function readSessionMessagesTail(
  sessionFile: string,
  options: { readonly limit: number; readonly before?: number },
): Promise<readonly SessionMessage[] | undefined> {
  return readSessionMessagesTailLegacy(sessionFile, options);
}

/** Legacy in-process reader retained for deterministic tests and worker fallback. */
export async function readSessionMessagesTailLegacy(
  sessionFile: string,
  options: { readonly limit: number; readonly before?: number },
): Promise<readonly SessionMessage[] | undefined> {
  return readSessionMessagesTailFromWorkerModule(sessionFile, options);
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

class HttpBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
  }
}

/**
 * Thrown by getOrOpenSession when a sessionId resolves to neither a hot handle
 * nor a known cold session file. Carries a 404 status so the top-level request
 * handler (and extension-route dispatch) maps an unknown session to a clean
 * not-found instead of a 500 stack leak. Generic errors still surface as 500.
 */
class SessionNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(sessionId: string) {
    super(`Unknown session: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    received += buf.length;
    if (received > JSON_BODY_MAX_BYTES) throw new HttpBodyError(413, "request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpBodyError(400, "request body was not valid JSON");
  }
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
  ".webmanifest": "application/manifest+json; charset=utf-8",
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
  // index.html and the service worker must stay fresh so deploys/SW updates
  // are picked up promptly; everything else is content-hashed and immutable.
  if (candidate.endsWith("index.html") || candidate.endsWith("service-worker.js")) {
    res.setHeader("Cache-Control", "no-cache");
  } else {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(candidate);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
  return true;
}

/**
 * Resolve the official pi-crust extension packages from node_modules.
 *
 * Each one is an independently published npm package (`@cemoody/pi-crust-ext-*`).
 * When `pi-crust` is installed alone (`npx pi-crust`) none of these are present
 * and pi-crust runs lean. When `pi-crust-full` is installed it pulls them all
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
    "@cemoody/pi-crust-ext-pr-story",
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

