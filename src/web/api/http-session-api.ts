import type { ExtensionUiResponse } from "../../shared/protocol.js";
import type { DashboardMessage, ModelOption, NewSessionInput, PromptAttachment, SessionCardData, SessionDashboardApi } from "./session-api.js";

const API_BASE = import.meta.env.VITE_PI_REMOTE_API_BASE ?? "";

export class HttpSessionDashboardApi implements SessionDashboardApi {
  async getDefaultCwd(): Promise<string> {
    const health = await request<{ defaultCwd: string }>("/api/health");
    return health.defaultCwd;
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

  async abort(sessionId: string): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST", body: {} });
  }

  streamEvents(sessionId: string, onEvent: (event: unknown) => void): () => void {
    const source = new EventSource(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/events`);
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        // ignore malformed payloads
      }
    };
    return () => source.close();
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
