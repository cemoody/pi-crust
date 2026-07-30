import type { ExtensionUiResponse } from "../../shared/protocol.js";
import type { AppBrandingInfo, AppBrandingSettings, AuthMutationResponse, AuthProviderListResponse, CronApi, CronJobInput, CronJobPatch, CronJobView, CronListResponse, CronRunResponse, DashboardMessage, ExtensionRegistryInfo, ExtensionReloadResponse, ExtensionSettingsResponse, ExtensionUpdateResult, ExtensionUpdatesResponse, GetMessagesOptions, ModelOption, NewSessionInput, OAuthLoginSnapshot, PromptAttachment, ServerInfo, SessionCardData, SessionDashboardApi, SessionSearchResult } from "./session-api.js";
import { recordClientEvent, getTabSessionId } from "../utils/client-telemetry.js";
import { createStreamEvents, selectRealtimeTransport, type StreamEvents } from "./session-streamer.js";
import { createRealtimeConnection, type RealtimeConnection, type RealtimeTransport } from "./realtime-connection.js";
import { createSseSessionStream } from "./sse-session-stream.js";

export { SSE_SILENCE_CHECK_INTERVAL_MS, SSE_SILENCE_THRESHOLD_MS } from "./sse-session-stream.js";
import { io as socketIoClient } from "socket.io-client";

const API_BASE = import.meta.env.VITE_PI_CRUST_API_BASE ?? "";

const lazyIo = () => socketIoClient;

export class HttpSessionDashboardApi implements SessionDashboardApi {
  /** Lazily-built streamer; selects SSE (default) or the Socket.IO gateway. */
  private streamer?: StreamEvents;
  async request<T = unknown>(path: string, options: { readonly method?: string; readonly body?: unknown } = {}): Promise<T> {
    return request<T>(path, options);
  }

  async getDefaultCwd(): Promise<string> {
    const health = await request<{ defaultCwd: string }>("/api/health");
    return health.defaultCwd;
  }

  async getHomeCwd(): Promise<string | undefined> {
    const health = await request<{ homeCwd?: string }>("/api/health");
    return health.homeCwd;
  }

  async getServerInfo(): Promise<ServerInfo> {
    return request<ServerInfo>("/api/health");
  }

  async getExtensions(): Promise<ExtensionRegistryInfo> {
    return request<ExtensionRegistryInfo>("/api/extensions");
  }

  async reloadExtensions(): Promise<ExtensionReloadResponse> {
    return request<ExtensionReloadResponse>("/api/extensions/reload", { method: "POST", body: {} });
  }

  async getExtensionSettings(): Promise<ExtensionSettingsResponse> {
    return request<ExtensionSettingsResponse>("/api/extensions/settings");
  }

  async setExtensionEnabled(extensionId: string, enabled: boolean): Promise<ExtensionReloadResponse> {
    return request<ExtensionReloadResponse>(`/api/extensions/${encodeURIComponent(extensionId)}/enabled`, { method: "POST", body: { enabled } });
  }

  async setAppBranding(branding: AppBrandingSettings): Promise<AppBrandingInfo> {
    return request<AppBrandingInfo>("/api/settings/branding", { method: "POST", body: branding });
  }

  async setSetting(key: string, value: unknown): Promise<ExtensionReloadResponse> {
    return request<ExtensionReloadResponse>("/api/settings", { method: "POST", body: { key, value } });
  }

  async listAuthProviders(): Promise<AuthProviderListResponse> {
    return request<AuthProviderListResponse>("/api/auth/providers");
  }

  async login(provider: string, apiKey: string): Promise<AuthMutationResponse> {
    return request<AuthMutationResponse>("/api/auth/login", { method: "POST", body: { provider, apiKey } });
  }

  async logout(provider: string): Promise<AuthMutationResponse> {
    return request<AuthMutationResponse>("/api/auth/logout", { method: "POST", body: { provider } });
  }

  async startOAuthLogin(provider: string): Promise<OAuthLoginSnapshot> {
    return request<OAuthLoginSnapshot>("/api/auth/oauth/start", { method: "POST", body: { provider } });
  }

  async pollOAuthLogin(flowId: string, cursor: number): Promise<OAuthLoginSnapshot> {
    return request<OAuthLoginSnapshot>(`/api/auth/oauth/${encodeURIComponent(flowId)}?cursor=${cursor}`);
  }

  async submitOAuthLogin(flowId: string, requestId: string, value: string): Promise<OAuthLoginSnapshot> {
    return request<OAuthLoginSnapshot>(`/api/auth/oauth/${encodeURIComponent(flowId)}/input`, { method: "POST", body: { requestId, value } });
  }

  async cancelOAuthLogin(flowId: string): Promise<OAuthLoginSnapshot> {
    return request<OAuthLoginSnapshot>(`/api/auth/oauth/${encodeURIComponent(flowId)}/cancel`, { method: "POST", body: {} });
  }

  async installExtensionPackage(source: string): Promise<ExtensionReloadResponse> {
    return request<ExtensionReloadResponse>("/api/extensions/packages", { method: "POST", body: { source } });
  }

  async removeExtensionPackage(source: string): Promise<ExtensionReloadResponse> {
    return request<ExtensionReloadResponse>("/api/extensions/packages/remove", { method: "POST", body: { source } });
  }

  async checkExtensionUpdates(force?: boolean): Promise<ExtensionUpdatesResponse> {
    return request<ExtensionUpdatesResponse>(`/api/extensions/updates${force ? "?force=1" : ""}`);
  }

  async updateExtensionPackage(source: string): Promise<ExtensionUpdateResult> {
    return request<ExtensionUpdateResult>("/api/extensions/packages/update", { method: "POST", body: { source } });
  }

  async runExtensionCommand(extensionId: string, invocationName: string, input?: unknown): Promise<unknown> {
    return request(`/api/extensions/${encodeURIComponent(extensionId)}/commands/${encodeURIComponent(invocationName)}`, { method: "POST", body: input ?? {} });
  }

  async listSessions(cwd?: string, options: { readonly includeSubagents?: boolean } = {}): Promise<readonly SessionCardData[]> {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (options.includeSubagents) params.set("includeSubagents", "true");
    const query = params.toString() ? `?${params.toString()}` : "";
    return request<SessionCardData[]>(`/api/sessions${query}`);
  }

  async searchSessions(query: string, options: { readonly cwd?: string; readonly limit?: number; readonly includeSubagents?: boolean } = {}): Promise<readonly SessionSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (options.cwd) params.set("cwd", options.cwd);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.includeSubagents) params.set("includeSubagents", "true");
    return request<SessionSearchResult[]>(`/api/sessions/search?${params.toString()}`);
  }

  async listSessionStatuses(cwd?: string, options: { readonly includeSubagents?: boolean } = {}): Promise<readonly SessionCardData[]> {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (options.includeSubagents) params.set("includeSubagents", "true");
    const query = params.toString() ? `?${params.toString()}` : "";
    return request<SessionCardData[]>(`/api/sessions/statuses${query}`);
  }

  async createSession(input: NewSessionInput): Promise<SessionCardData> {
    return request<SessionCardData>("/api/sessions", { method: "POST", body: input });
  }

  async renameSession(sessionId: string, name: string): Promise<SessionCardData> {
    return request<SessionCardData>(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, { method: "POST", body: { name } });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, { method: "POST", body: {} });
  }

  async getSession(sessionId: string): Promise<SessionCardData> {
    return request<SessionCardData>(`/api/sessions/${encodeURIComponent(sessionId)}/state`);
  }

  async getMessages(sessionId: string, options?: GetMessagesOptions): Promise<readonly DashboardMessage[]> {
    const query: string[] = [];
    if (options?.limit !== undefined) query.push(`limit=${encodeURIComponent(options.limit)}`);
    if (options?.before !== undefined) query.push(`before=${encodeURIComponent(options.before)}`);
    if (options?.after !== undefined) query.push(`after=${encodeURIComponent(options.after)}`);
    const suffix = query.length === 0 ? "" : `?${query.join("&")}`;
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`);
  }

  async prompt(sessionId: string, text: string, attachments: readonly PromptAttachment[] = []): Promise<readonly DashboardMessage[]> {
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { method: "POST", body: { text, attachments } });
  }

  async bash(sessionId: string, command: string, includeInContext: boolean): Promise<readonly DashboardMessage[]> {
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/bash`, { method: "POST", body: { command, includeInContext } });
  }

  async compact(sessionId: string, customInstructions?: string): Promise<readonly DashboardMessage[]> {
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, {
      method: "POST",
      body: customInstructions?.trim() ? { customInstructions } : {},
    });
  }

  async reloadSession(sessionId: string): Promise<SessionCardData> {
    return request<SessionCardData>(`/api/sessions/${encodeURIComponent(sessionId)}/reload`, { method: "POST", body: {} });
  }

  async getPiCommands(sessionId: string) {
    const response = await request<{ commands: import("../../shared/slash-command-routing.js").PiDynamicCommandInfo[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/commands`);
    return response.commands;
  }

  async runPiSlashCommand(sessionId: string, text: string): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/pi-command`, { method: "POST", body: { text } });
  }

  async abort(sessionId: string): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST", body: {} });
  }

  streamEvents(sessionId: string, onEvent: (event: unknown) => void): () => void {
    if (!this.streamer) {
      this.streamer = createStreamEvents({
        transport: selectRealtimeTransport(import.meta.env as unknown as Record<string, string | undefined>),
        sse: (id, cb) => this.streamEventsViaSse(id, cb),
        socketio: () => this.buildRealtimeConnection(),
        onClientEvent: (event) => recordClientEvent(event),
      });
    }
    return this.streamer(sessionId, onEvent);
  }

  /** Build the multiplexed Socket.IO connection (one per tab) used when the
   *  VITE_PI_CRUST_REALTIME=socketio flag is set. Falls back to SSE on repeated
   *  connect failures. */
  private buildRealtimeConnection(): RealtimeConnection {
    const transportFactory = (): RealtimeTransport => {
      const socket = lazyIo()(API_BASE || undefined, { path: "/socket.io/", transports: ["websocket", "polling"], autoConnect: false });
      return {
        get connected() { return socket.connected; },
        connect() { socket.connect(); },
        disconnect() { socket.disconnect(); },
        on: (event, handler) => { socket.on(event as never, handler as never); },
        off: (event, handler) => { socket.off(event as never, handler as never); },
        emit: (event, payload, ack) => { if (ack) socket.emit(event as never, payload as never, ack as never); else socket.emit(event as never, payload as never); },
      };
    };
    const broadcast = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pi-crust-realtime") : undefined;
    const visibility = typeof document !== "undefined" ? {
      isVisible: () => document.visibilityState === "visible",
      subscribe: (cb: () => void) => { document.addEventListener("visibilitychange", cb); return () => document.removeEventListener("visibilitychange", cb); },
    } : undefined;
    return createRealtimeConnection({
      transportFactory,
      // May be "" before telemetry init; the connection self-assigns a unique
      // id in that case (empty/duplicate ids break leader election).
      tabId: getTabSessionId() || undefined,
      broadcast,
      visibility,
      onClientEvent: (event) => recordClientEvent(event),
    } as Parameters<typeof createRealtimeConnection>[0]);
  }

  private streamEventsViaSse(sessionId: string, onEvent: (event: unknown) => void): () => void {
    return createSseSessionStream({ apiBase: API_BASE, sessionId, onEvent });
  }

  async listModels(): Promise<readonly ModelOption[]> {
    return request<ModelOption[]>("/api/models");
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<SessionCardData> {
    return request<SessionCardData>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, { method: "POST", body: { provider, modelId } });
  }

  async respondToExtensionUi(sessionId: string, response: ExtensionUiResponse): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/extension-ui-response`, { method: "POST", body: response });
  }

  cron: CronApi = {
    list: () => request<CronListResponse>("/api/cron"),
    create: (input: CronJobInput) => request<CronJobView>("/api/cron", { method: "POST", body: input }),
    update: (id: string, patch: CronJobPatch) => request<CronJobView>(`/api/cron/${encodeURIComponent(id)}`, { method: "POST", body: patch }),
    delete: async (id: string) => { await request(`/api/cron/${encodeURIComponent(id)}/delete`, { method: "POST", body: {} }); },
    runNow: (id: string) => request<CronRunResponse>(`/api/cron/${encodeURIComponent(id)}/run`, { method: "POST", body: {} }),
  };
}

async function request<T>(path: string, options: { readonly method?: string; readonly body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const startedAt = Date.now();
  const response = await fetch(`${API_BASE}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    // Emit an 'api-error' telemetry event for every non-2xx API response.
    // This pairs 1:1 with the server-side pirpc.request.rejected_handle_closed
    // log when the failure is the closed-handle bug; for any other 5xx it
    // still surfaces the symptom client-side. Best-effort: the throw below
    // must not be blocked by telemetry.
    try {
      recordClientEvent({
        kind: "api-error",
        method: init.method ?? "GET",
        path,
        status: response.status,
        ageMs: Date.now() - startedAt,
        tabSessionId: getTabSessionId(),
        errorPreview: typeof data?.error === "string" ? String(data.error).slice(0, 200) : undefined,
      });
    } catch { /* telemetry must never break the app */ }
    throw new Error(data?.error ?? `Request failed: ${response.status}`);
  }
  return data as T;
}
