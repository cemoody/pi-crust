import fs from "node:fs/promises";
import type { ExtensionUiResponse } from "../../shared/protocol.js";
import type { PathPolicy } from "../security/path-policy.js";
import type { CloneSessionResult, CreateSessionOptions, ForkMessage, ForkSessionResult, ModelInfo, PiAdapter, PiEvent, PiEventListener, PiSessionHandle, PromptAttachment, SeqEventListener, SessionListItem, SessionState } from "../pi/types.js";
import { WorkerRegistry } from "./worker-registry.js";

export interface SessionRegistryOptions {
  readonly adapter: PiAdapter;
  readonly pathPolicy: PathPolicy;
  readonly workerRegistry?: WorkerRegistry;
  readonly eventRingSize?: number;
}

export interface RegisteredSession {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly handle: PiSessionHandle;
}

interface RingEntry {
  readonly seq: number;
  readonly event: PiEvent;
}

interface SessionInternal {
  readonly registered: RegisteredSession;
  readonly ring: RingEntry[];
  readonly subscribers: Set<SeqEventListener>;
  nextLocalSeq: number;
  /** Greatest seq we've delivered (used so the SSE layer can read "current top"). */
  lastSeq: number;
}

const DEFAULT_RING_SIZE = 500;

export class SessionRegistry {
  private readonly adapter: PiAdapter;
  private readonly pathPolicy: PathPolicy;
  private readonly workerRegistry: WorkerRegistry;
  private readonly ringSize: number;
  private readonly sessions = new Map<string, SessionInternal>();

  constructor(options: SessionRegistryOptions) {
    this.adapter = options.adapter;
    this.pathPolicy = options.pathPolicy;
    this.workerRegistry = options.workerRegistry ?? new WorkerRegistry();
    this.ringSize = options.eventRingSize ?? DEFAULT_RING_SIZE;
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

  /**
   * Scan the worker registry for live detached supervisors and reattach to
   * each. Called by the API server at boot so sessions survive `kill <api-pid>`.
   * Returns the list of reattached session ids.
   */
  async reattachAll(): Promise<readonly string[]> {
    if (!this.adapter.reattachSession) return [];
    const alive = await this.workerRegistry.listAlive();
    const reattached: string[] = [];
    for (const status of alive) {
      if (this.sessions.has(status.sessionId)) continue;
      try {
        // Only reattach when path policy still considers the cwd/sessionFile allowed.
        this.pathPolicy.assertAllowedCwd(status.cwd);
        this.pathPolicy.assertAllowedSessionFile(status.sessionFile);
        const handle = await this.adapter.reattachSession({
          sessionId: status.sessionId,
          socketPath: status.socketPath,
          sessionFile: status.sessionFile,
          cwd: status.cwd,
        });
        this.register(handle);
        reattached.push(status.sessionId);
      } catch (err) {
        // Best-effort. Log to stderr so the caller can see why a worker was skipped.
        console.warn(`[session-registry] failed to reattach ${status.sessionId}:`, err instanceof Error ? err.message : err);
      }
    }
    return reattached;
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
    return this.getInternal(sessionId).registered;
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
    if (this.adapter.forkSession) {
      const { result, handle } = await this.adapter.forkSession(registered.handle, entryId);
      return { result, session: result.cancelled ? registered : this.register(handle) };
    }
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
    const wrapped: SeqEventListener = (event) => listener(event);
    return this.subscribeWithSeq(sessionId, wrapped);
  }

  subscribeWithSeq(sessionId: string, listener: SeqEventListener): () => void {
    const internal = this.getInternal(sessionId);
    internal.subscribers.add(listener);
    return () => { internal.subscribers.delete(listener); };
  }

  /**
   * Replay buffered events with seq > fromSeq, then subscribe live. If
   * fromSeq points to a seq older than the ring's lowest seq the listener
   * first receives a synthetic session_resync event so the client knows it
   * has missed history and should refetch state.
   */
  subscribeFromSeq(sessionId: string, fromSeq: number | null, listener: SeqEventListener): () => void {
    const internal = this.getInternal(sessionId);
    if (fromSeq !== null && Number.isFinite(fromSeq)) {
      const ringLow = internal.ring.length > 0 ? internal.ring[0]!.seq : null;
      if (ringLow !== null && fromSeq < ringLow - 1) {
        listener({ type: "session_resync", fromSeq, ringLowSeq: ringLow, lastSeq: internal.lastSeq } as unknown as PiEvent, internal.lastSeq);
      }
      for (const entry of internal.ring) {
        if (entry.seq > fromSeq) listener(entry.event, entry.seq);
      }
    }
    return this.subscribeWithSeq(sessionId, listener);
  }

  /** Explicit session delete: RPC-shutdown the worker and forget. */
  async disposeSession(sessionId: string): Promise<void> {
    const internal = this.getInternal(sessionId);
    internal.subscribers.clear();
    await internal.registered.handle.dispose();
    this.sessions.delete(sessionId);
  }

  /** API shutdown: close the socket but keep the worker (supervisor) alive. */
  async detachSession(sessionId: string): Promise<void> {
    const internal = this.getInternal(sessionId);
    internal.subscribers.clear();
    const handle = internal.registered.handle;
    if (handle.detach) await handle.detach();
    else await handle.dispose();
    this.sessions.delete(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const internal = this.getInternal(sessionId);
    internal.subscribers.clear();
    await internal.registered.handle.dispose();
    this.sessions.delete(sessionId);
    await fs.rm(internal.registered.sessionFile, { force: true });
    await this.workerRegistry.removeSession(sessionId);
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.disposeSession(id)));
  }

  /** Called on API SIGTERM/SIGINT. Closes sockets without killing workers. */
  async detachAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.detachSession(id).catch(() => undefined)));
  }

  private getInternal(sessionId: string): SessionInternal {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private register(handle: PiSessionHandle): RegisteredSession {
    const registered: RegisteredSession = {
      id: handle.id,
      cwd: handle.cwd,
      sessionFile: handle.sessionFile,
      handle,
    };
    const internal: SessionInternal = {
      registered,
      ring: [],
      subscribers: new Set(),
      nextLocalSeq: 1,
      lastSeq: 0,
    };
    this.sessions.set(handle.id, internal);

    const onEvent = (event: PiEvent, seq: number) => {
      internal.lastSeq = seq;
      internal.ring.push({ seq, event });
      if (internal.ring.length > this.ringSize) internal.ring.shift();
      for (const listener of internal.subscribers) {
        try { listener(event, seq); } catch { /* listener errors must not break the bus */ }
      }
    };

    if (handle.subscribeWithSeq) {
      handle.subscribeWithSeq(onEvent);
    } else {
      handle.subscribe((event) => {
        const seq = internal.nextLocalSeq++;
        onEvent(event, seq);
      });
    }
    return registered;
  }

  private replaceSessionId(oldSessionId: string, handle: PiSessionHandle): RegisteredSession {
    const old = this.sessions.get(oldSessionId);
    this.sessions.delete(oldSessionId);
    const registered = this.register(handle);
    if (old) {
      // Transfer any remaining subscribers to the new session id, so SSE
      // clients survive fork/clone identity changes.
      const next = this.sessions.get(handle.id)!;
      for (const listener of old.subscribers) next.subscribers.add(listener);
    }
    return registered;
  }
}
