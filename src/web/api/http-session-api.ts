import type { ExtensionUiResponse } from "../../shared/protocol.js";
import type { AppBrandingInfo, AppBrandingSettings, CronApi, CronJobInput, CronJobPatch, CronJobView, CronListResponse, CronRunResponse, DashboardMessage, ExtensionRegistryInfo, ExtensionReloadResponse, ExtensionSettingsResponse, GetMessagesOptions, ModelOption, NewSessionInput, PromptAttachment, ServerInfo, SessionCardData, SessionDashboardApi } from "./session-api.js";
import { recordClientEvent, getTabSessionId } from "../utils/client-telemetry.js";

const API_BASE = import.meta.env.VITE_PI_CRUST_API_BASE ?? "";

export class HttpSessionDashboardApi implements SessionDashboardApi {
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

  async installExtensionPackage(source: string): Promise<ExtensionReloadResponse> {
    return request<ExtensionReloadResponse>("/api/extensions/packages", { method: "POST", body: { source } });
  }

  async removeExtensionPackage(source: string): Promise<ExtensionReloadResponse> {
    return request<ExtensionReloadResponse>("/api/extensions/packages/remove", { method: "POST", body: { source } });
  }

  async runExtensionCommand(extensionId: string, invocationName: string, input?: unknown): Promise<unknown> {
    return request(`/api/extensions/${encodeURIComponent(extensionId)}/commands/${encodeURIComponent(invocationName)}`, { method: "POST", body: input ?? {} });
  }

  async listSessions(cwd?: string): Promise<readonly SessionCardData[]> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return request<SessionCardData[]>(`/api/sessions${query}`);
  }

  async listSessionStatuses(cwd?: string): Promise<readonly SessionCardData[]> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
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
    const suffix = query.length === 0 ? "" : `?${query.join("&")}`;
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`);
  }

  async prompt(sessionId: string, text: string, attachments: readonly PromptAttachment[] = []): Promise<readonly DashboardMessage[]> {
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { method: "POST", body: { text, attachments } });
  }

  async bash(sessionId: string, command: string, includeInContext: boolean): Promise<readonly DashboardMessage[]> {
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/bash`, { method: "POST", body: { command, includeInContext } });
  }

  async abort(sessionId: string): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST", body: {} });
  }

  streamEvents(sessionId: string, onEvent: (event: unknown) => void): () => void {
    const openedAt = Date.now();
    // Pass the per-tab id so the server can evict an older SSE for the same
    // tab when this tab re-opens one (e.g. on rapid session-switching). Without
    // this, leaked streams accumulate against Chrome's 6-per-origin HTTP/1.1
    // connection budget and new requests stall. See tests/playwright/
    // sse-connection-pool.spec.ts for the repro.
    const tab = getTabSessionId();
    const qs = tab ? `?tabSessionId=${encodeURIComponent(tab)}` : "";
    const url = `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/events${qs}`;

    let source: EventSource;
    let lastMessageAt = Date.now();
    let silenceWarnedAt = 0;
    let stopped = false;

    const wireHandlers = () => {
      source.onmessage = (event) => {
        lastMessageAt = Date.now();
        try {
          onEvent(JSON.parse(event.data));
        } catch {
          // ignore malformed payloads
        }
      };
      source.onopen = () => {
        lastMessageAt = Date.now();
        recordClientEvent({
          kind: "sse-client-open",
          sessionId,
          tabSessionId: getTabSessionId(),
        });
      };
      source.onerror = () => {
        recordClientEvent({
          kind: "sse-client-error",
          sessionId,
          readyState: source.readyState,
          ageMs: Date.now() - openedAt,
          tabSessionId: getTabSessionId(),
        });
      };
    };

    const openSource = () => {
      source = new EventSource(url);
      wireHandlers();
      lastMessageAt = Date.now();
    };
    openSource();

    // Re-establish a stream that the browser tore down. Mobile browsers
    // (iOS Safari / Android Chrome) suspend networking when a tab is
    // backgrounded; after ~minutes the EventSource ends up either CLOSED
    // with no `onerror` delivered, or stuck in OPEN with a dead socket.
    // Without this, returning to the tab after ~20 minutes leaves the UI
    // permanently silent until the user reloads. See the
    // "mobile background reconnect" suite in
    // tests/unit/http-session-api-telemetry.test.ts.
    const reconnect = (reason: string) => {
      if (stopped) return;
      try { source.close(); } catch { /* ignore */ }
      recordClientEvent({
        kind: "sse-client-reconnect",
        sessionId,
        reason,
        ageMs: Date.now() - openedAt,
        tabSessionId: getTabSessionId(),
      });
      openSource();
    };

    // Silence detector. The 2026-05-24 outage was a session whose SSE was
    // OPEN (no error fired) but received zero events because the API's
    // in-memory session handle had silently closed. EventSource never fires
    // 'error' for that — the TCP connection is healthy, the data just
    // doesn't flow. Emit a structured client-side warning so we can detect
    // the symptom even when the browser API gives us no signal, then self-
    // heal by reconnecting.
    const silenceTimer = setInterval(() => {
      // Only count silence while the tab is visible; a backgrounded tab
      // legitimately may not be receiving events because the server doesn't
      // push to it. visibilityState gated so we don't flood the log.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (source.readyState !== EventSource.OPEN) {
        // Visible tab + non-OPEN stream means the browser killed the SSE.
        // Recover proactively (covers the case where visibilitychange did
        // not fire on resume, or fired before readyState updated).
        reconnect("silence-tick-not-open");
        return;
      }
      const idleMs = Date.now() - lastMessageAt;
      if (idleMs >= SSE_SILENCE_THRESHOLD_MS && Date.now() - silenceWarnedAt >= SSE_SILENCE_THRESHOLD_MS) {
        silenceWarnedAt = Date.now();
        recordClientEvent({
          kind: "sse-silence",
          sessionId,
          idleMs,
          ageMs: Date.now() - openedAt,
          tabSessionId: getTabSessionId(),
        });
      }
    }, SSE_SILENCE_CHECK_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      // Mobile suspend signature: the browser closed the underlying socket
      // while we were hidden. Reconnect immediately so the user sees
      // streaming resume the instant they return to the tab.
      if (source.readyState !== EventSource.OPEN) {
        reconnect("visibility-restored-stream-closed");
        return;
      }
      // "Zombie socket" signature: readyState lies and says OPEN, but no
      // bytes have flowed for the suspend window. If we were hidden long
      // enough that any server-pushed event must have been missed, force
      // a refresh.
      const idleMs = Date.now() - lastMessageAt;
      if (idleMs >= SSE_SILENCE_THRESHOLD_MS) {
        reconnect("visibility-restored-stream-stale");
      }
    };
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      stopped = true;
      clearInterval(silenceTimer);
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      try { source.close(); } catch { /* ignore */ }
      recordClientEvent({
        kind: "sse-client-close",
        sessionId,
        ageMs: Date.now() - openedAt,
        tabSessionId: getTabSessionId(),
      });
    };
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

// SSE silence-detection thresholds. We only emit 'sse-silence' for a tab
// that is visible and has been idle this long; subsequent emissions are
// rate-limited by the same threshold to avoid log floods on a chronically
// broken handle.
export const SSE_SILENCE_THRESHOLD_MS = 30_000;
export const SSE_SILENCE_CHECK_INTERVAL_MS = 15_000;

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
