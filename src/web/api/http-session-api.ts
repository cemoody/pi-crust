import type { ExtensionUiResponse } from "../../shared/protocol.js";
import type { CloneSessionResult, CronApi, CronJobInput, CronJobPatch, CronJobView, CronListResponse, CronRunResponse, DashboardMessage, ForkMessageOption, ForkSessionResult, ModelOption, NewSessionInput, PromptAttachment, ServerInfo, SessionCardData, SessionDashboardApi } from "./session-api.js";
import { recordClientEvent, getTabSessionId } from "../utils/client-telemetry.js";

const API_BASE = import.meta.env.VITE_PI_REMOTE_API_BASE ?? "";

export class HttpSessionDashboardApi implements SessionDashboardApi {
  async getDefaultCwd(): Promise<string> {
    const health = await request<{ defaultCwd: string }>("/api/health");
    return health.defaultCwd;
  }

  async getServerInfo(): Promise<ServerInfo> {
    return request<ServerInfo>("/api/health");
  }

  async listSessions(cwd?: string): Promise<readonly SessionCardData[]> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return request<SessionCardData[]>(`/api/sessions${query}`);
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

  async getMessages(sessionId: string): Promise<readonly DashboardMessage[]> {
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  }

  async prompt(sessionId: string, text: string, attachments: readonly PromptAttachment[] = []): Promise<readonly DashboardMessage[]> {
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { method: "POST", body: { text, attachments } });
  }

  async bash(sessionId: string, command: string, includeInContext: boolean): Promise<readonly DashboardMessage[]> {
    return request<DashboardMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/bash`, { method: "POST", body: { command, includeInContext } });
  }

  async getForkMessages(sessionId: string): Promise<readonly ForkMessageOption[]> {
    return request<ForkMessageOption[]>(`/api/sessions/${encodeURIComponent(sessionId)}/fork-messages`);
  }

  async forkSession(sessionId: string, entryId: string): Promise<ForkSessionResult> {
    return request<ForkSessionResult>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: { entryId } });
  }

  async cloneSession(sessionId: string): Promise<CloneSessionResult> {
    return request<CloneSessionResult>(`/api/sessions/${encodeURIComponent(sessionId)}/clone`, { method: "POST", body: {} });
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
    const source = new EventSource(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/events${qs}`);
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        // ignore malformed payloads
      }
    };
    source.onopen = () => {
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
    return () => {
      source.close();
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

async function request<T>(path: string, options: { readonly method?: string; readonly body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${API_BASE}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(data?.error ?? `Request failed: ${response.status}`);
  return data as T;
}
