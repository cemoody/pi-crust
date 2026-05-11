import type { ExtensionUiResponse } from "../../shared/protocol.js";
import type { PathPolicy } from "../security/path-policy.js";
import type { CloneSessionResult, CreateSessionOptions, ForkMessage, ForkSessionResult, ModelInfo, PiAdapter, PiEventListener, PiSessionHandle, PromptAttachment, SessionListItem, SessionState } from "../pi/types.js";

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

  async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    await this.getSession(sessionId).handle.setModel(provider, modelId);
  }

  async getForkMessages(sessionId: string): Promise<readonly ForkMessage[]> {
    const handle = this.getSession(sessionId).handle;
    if (!handle.getForkMessages) throw new Error("Session adapter does not support forking");
    return handle.getForkMessages();
  }

  async forkSession(sessionId: string, entryId: string): Promise<{ readonly result: ForkSessionResult; readonly session: RegisteredSession }> {
    const registered = this.getSession(sessionId);
    if (!registered.handle.fork) throw new Error("Session adapter does not support forking");
    const result = await registered.handle.fork(entryId);
    return { result, session: result.cancelled ? registered : this.replaceSessionId(sessionId, registered.handle) };
  }

  async cloneSession(sessionId: string): Promise<{ readonly result: CloneSessionResult; readonly session: RegisteredSession }> {
    const registered = this.getSession(sessionId);
    if (!registered.handle.clone) throw new Error("Session adapter does not support cloning");
    const result = await registered.handle.clone();
    return { result, session: result.cancelled ? registered : this.replaceSessionId(sessionId, registered.handle) };
  }

  async respondToExtensionUi(sessionId: string, response: ExtensionUiResponse): Promise<void> {
    const handle = this.getSession(sessionId).handle;
    if (!handle.respondToExtensionUi) throw new Error("Session adapter does not support extension UI responses");
    await handle.respondToExtensionUi(response);
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

  private replaceSessionId(oldSessionId: string, handle: PiSessionHandle): RegisteredSession {
    this.sessions.delete(oldSessionId);
    return this.register(handle);
  }
}
