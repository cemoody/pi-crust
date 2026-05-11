import type { PathPolicy } from "../security/path-policy.js";
import type { CreateSessionOptions, DashboardConfigurationInfo, ModelInfo, PiAdapter, PiEventListener, PiSessionHandle, PromptAttachment, SessionListItem, SessionState } from "../pi/types.js";

export interface SessionRegistryOptions {
  readonly adapter: PiAdapter;
  readonly pathPolicy: PathPolicy;
}

export interface RegisteredSession {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly handle: PiSessionHandle;
}

export class SessionRegistry {
  private readonly adapter: PiAdapter;
  private readonly pathPolicy: PathPolicy;
  private readonly sessions = new Map<string, RegisteredSession>();

  constructor(options: SessionRegistryOptions) {
    this.adapter = options.adapter;
    this.pathPolicy = options.pathPolicy;
  }

  get hotSessionCount(): number {
    return this.sessions.size;
  }

  async createSession(options: CreateSessionOptions): Promise<RegisteredSession> {
    const cwd = this.pathPolicy.assertAllowedCwd(options.cwd);
    const handle = await this.adapter.createSession({ ...options, cwd });
    return this.register(handle);
  }

  async openSession(sessionFile: string): Promise<RegisteredSession> {
    const allowedFile = this.pathPolicy.assertAllowedSessionFile(sessionFile);
    const handle = await this.adapter.openSession({ sessionFile: allowedFile });
    this.pathPolicy.assertAllowedCwd(handle.cwd);
    return this.register(handle);
  }

  async listSessions(cwd?: string): Promise<readonly SessionListItem[]> {
    const allowedCwd = cwd === undefined ? undefined : this.pathPolicy.assertAllowedCwd(cwd);
    const sessions = await this.adapter.listSessions(allowedCwd);
    return sessions.filter((session) => {
      try {
        this.pathPolicy.assertAllowedCwd(session.cwd);
        this.pathPolicy.assertAllowedSessionFile(session.sessionFile);
        return true;
      } catch {
        return false;
      }
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSession(sessionId: string): RegisteredSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  async prompt(sessionId: string, message: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    await this.getSession(sessionId).handle.prompt(message, attachments);
  }

  async abort(sessionId: string): Promise<void> {
    await this.getSession(sessionId).handle.abort();
  }

  async setSessionName(sessionId: string, name: string): Promise<SessionState> {
    return this.getSession(sessionId).handle.setSessionName(name);
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.adapter.listModels();
  }

  async getConfiguration(): Promise<DashboardConfigurationInfo> {
    if (!this.adapter.getConfiguration) throw new Error("Configuration API is not available");
    return this.adapter.getConfiguration();
  }

  async saveApiKey(provider: string, apiKey: string): Promise<DashboardConfigurationInfo> {
    if (!this.adapter.saveApiKey) throw new Error("Auth API is not available");
    return this.adapter.saveApiKey(provider, apiKey);
  }

  async logoutProvider(provider: string): Promise<DashboardConfigurationInfo> {
    if (!this.adapter.logoutProvider) throw new Error("Auth API is not available");
    return this.adapter.logoutProvider(provider);
  }

  async saveSetting(key: string, value: unknown): Promise<DashboardConfigurationInfo> {
    if (!this.adapter.saveSetting) throw new Error("Settings API is not available");
    return this.adapter.saveSetting(key, value);
  }

  async getScopedModels(): Promise<readonly string[]> {
    return this.adapter.getScopedModels ? this.adapter.getScopedModels() : [];
  }

  async setScopedModels(modelIds: readonly string[]): Promise<readonly string[]> {
    if (!this.adapter.setScopedModels) throw new Error("Scoped model API is not available");
    return this.adapter.setScopedModels(modelIds);
  }

  async reloadResources(): Promise<readonly string[]> {
    return this.adapter.reloadResources ? this.adapter.reloadResources() : [];
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    await this.getSession(sessionId).handle.setModel(provider, modelId);
  }

  subscribe(sessionId: string, listener: PiEventListener): () => void {
    return this.getSession(sessionId).handle.subscribe(listener);
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    await session.handle.dispose();
    this.sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.disposeSession(id)));
  }

  private register(handle: PiSessionHandle): RegisteredSession {
    const registered: RegisteredSession = {
      id: handle.id,
      cwd: handle.cwd,
      sessionFile: handle.sessionFile,
      handle,
    };
    this.sessions.set(handle.id, registered);
    return registered;
  }
}
