import type { DashboardConfigurationData, DashboardMessage, ModelOption, NewSessionInput, PromptAttachment, SessionCardData, SessionDashboardApi, SessionTreeData, SlashCommandOption } from "./session-api.js";

const API_BASE = import.meta.env.VITE_PI_REMOTE_API_BASE ?? "http://127.0.0.1:8787";

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

  async getLastAssistantText(sessionId: string): Promise<string | null> {
    const data = await request<{ text: string | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/last-assistant-text`);
    return data.text;
  }

  async getCommands(sessionId: string): Promise<readonly SlashCommandOption[]> {
    const data = await request<{ commands: readonly SlashCommandOption[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/commands`);
    return data.commands;
  }

  async compact(sessionId: string, customInstructions?: string): Promise<{ readonly summary: string; readonly tokensBefore?: number }> {
    return request<{ summary: string; tokensBefore?: number }>(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, { method: "POST", body: { customInstructions } });
  }

  async exportSession(sessionId: string, outputPath?: string): Promise<{ readonly path: string }> {
    return request<{ path: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/export`, { method: "POST", body: { outputPath } });
  }

  async reloadResources(sessionId?: string): Promise<{ readonly diagnostics?: readonly string[] }> {
    return request<{ diagnostics?: readonly string[] }>(`/api/config/reload`, { method: "POST", body: { sessionId } });
  }

  async importSession(path: string, cwd?: string): Promise<SessionCardData> {
    return request<SessionCardData>("/api/sessions/import", { method: "POST", body: { path, cwd } });
  }

  async getSessionTree(sessionId: string): Promise<SessionTreeData> {
    return request<SessionTreeData>(`/api/sessions/${encodeURIComponent(sessionId)}/tree`);
  }

  async navigateTree(sessionId: string, entryId: string, options: { readonly summary: "none" | "default" | "custom"; readonly customInstructions?: string }): Promise<{ readonly editorText?: string }> {
    return request<{ editorText?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/tree/navigate`, { method: "POST", body: { entryId, ...options } });
  }

  async setTreeLabel(sessionId: string, entryId: string, label: string | undefined): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/tree/label`, { method: "POST", body: { entryId, label } });
  }

  async forkSession(sessionId: string, entryId: string): Promise<SessionCardData & { readonly selectedText?: string }> {
    return request<SessionCardData & { selectedText?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: { entryId } });
  }

  async cloneSession(sessionId: string): Promise<SessionCardData> {
    return request<SessionCardData>(`/api/sessions/${encodeURIComponent(sessionId)}/clone`, { method: "POST", body: {} });
  }

  async getConfiguration(): Promise<DashboardConfigurationData> {
    return request<DashboardConfigurationData>("/api/config");
  }

  async saveApiKey(provider: string, apiKey: string): Promise<DashboardConfigurationData> {
    return request<DashboardConfigurationData>(`/api/auth/${encodeURIComponent(provider)}/api-key`, { method: "POST", body: { apiKey } });
  }

  async logoutProvider(provider: string): Promise<DashboardConfigurationData> {
    return request<DashboardConfigurationData>(`/api/auth/${encodeURIComponent(provider)}/logout`, { method: "POST", body: {} });
  }

  async saveSetting(key: string, value: unknown): Promise<DashboardConfigurationData> {
    return request<DashboardConfigurationData>("/api/config/settings", { method: "POST", body: { key, value } });
  }

  async getScopedModels(): Promise<readonly string[]> {
    const data = await request<{ modelIds: readonly string[] }>("/api/config/scoped-models");
    return data.modelIds;
  }

  async setScopedModels(modelIds: readonly string[]): Promise<readonly string[]> {
    const data = await request<{ modelIds: readonly string[] }>("/api/config/scoped-models", { method: "POST", body: { modelIds } });
    return data.modelIds;
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
