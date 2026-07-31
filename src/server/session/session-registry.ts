import fs from "node:fs/promises";
import type { ExtensionUiResponse } from "../../shared/protocol.js";
import { sanitizePiDynamicCommands } from "../../shared/slash-command-routing.js";
import type { PathPolicy } from "../security/path-policy.js";
import type { CloneSessionResult, CreateSessionOptions, ForkMessage, ForkSessionResult, ListSessionsOptions, ModelInfo, PiAdapter, PiEvent, PiEventListener, PiSessionHandle, PromptAttachment, SeqEventListener, SessionListItem, SessionState } from "../pi/types.js";
import { SessionLifecycle, type RegisteredSession } from "./lifecycle/session-lifecycle.js";
import { WorkerRegistry } from "./worker-registry.js";
import { persistOversizedTranscriptBodies, transcriptSidecarDirectory } from "../pi/transcripts/index.js";

export interface SessionRegistryOptions {
  readonly adapter: PiAdapter;
  readonly pathPolicy: PathPolicy;
  readonly workerRegistry?: WorkerRegistry;
  readonly eventRingSize?: number;
}

export type { RegisteredSession } from "./lifecycle/session-lifecycle.js";

interface PendingSessionMetadata {
  readonly sessionName?: string;
  readonly subagent: boolean;
  readonly hiddenFromList: boolean;
}

const DEFAULT_RING_SIZE = 500;

async function appendHiddenSessionMetadata(
  sessionFile: string,
  metadata: { readonly sessionName?: string; readonly subagent: boolean; readonly hiddenFromList: boolean },
): Promise<void> {
  if (!sessionFile.endsWith(".jsonl")) return;
  const entry = {
    type: "session_info",
    ...(metadata.sessionName ? { name: metadata.sessionName } : {}),
    ...(metadata.subagent ? { subagent: true } : {}),
    ...(metadata.hiddenFromList ? { hiddenFromList: true } : {}),
    timestamp: new Date().toISOString(),
  };
  await fs.appendFile(sessionFile, `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined);
}

export class SessionRegistry {
  private readonly adapter: PiAdapter;
  private readonly pathPolicy: PathPolicy;
  private readonly workerRegistry: WorkerRegistry;
  private readonly lifecycle: SessionLifecycle;
  /**
   * Pi creates a new JSONL lazily on its first prompt. Metadata therefore
   * must not be appended from createSession(): creating the file ourselves
   * causes Pi's first persistence attempt to fail with EEXIST.
   */
  private readonly pendingSessionMetadata = new Map<string, PendingSessionMetadata>();
  constructor(options: SessionRegistryOptions) {
    this.adapter = options.adapter;
    this.pathPolicy = options.pathPolicy;
    this.workerRegistry = options.workerRegistry ?? new WorkerRegistry();
    this.lifecycle = new SessionLifecycle({
      eventRingSize: options.eventRingSize ?? DEFAULT_RING_SIZE,
      onEvent: (session, event) => this.observeSessionEvent(session, event),
    });
  }

  get hotSessionCount(): number {
    return this.lifecycle.count;
  }

  /**
   * Per-session health snapshot for /api/health and operator dashboards.
   *
   * For each registered session, calls handle.isHealthy() (when supported)
   * to determine whether its underlying worker connection is still open.
   * A handle whose socket has silently closed will return `healthy: false`
   * — this is the symptom from the 2026-05-24 outage where 13 of 14
   * sessions had broken handles after 9.5h of API uptime and no operator
   * signal surfaced it until users hit "messages won't load".
   *
   * Adapters without isHealthy() (e.g. the mock adapter in tests) report
   * `healthy: true` by convention; their handles don't have a closeable
   * socket layer.
   */
  getSessionHealthSnapshot(): {
    total: number;
    healthy: number;
    broken: number;
    brokenSessionIds: string[];
  } {
    return this.lifecycle.healthSnapshot();
  }

  async createSession(options: CreateSessionOptions): Promise<RegisteredSession> {
    const cwd = this.pathPolicy.assertAllowedCwd(options.cwd);
    const handle = await this.adapter.createSession({ ...options, cwd });
    const registered = this.register(handle, options);
    if (options.subagent || options.hiddenFromList) {
      // Do not write the JSONL here. Pi's SessionManager creates a new file
      // with exclusive creation during the first prompt; a pre-emptive
      // session_info append makes that prompt fail with EEXIST.
      this.pendingSessionMetadata.set(registered.id, {
        ...(options.sessionName ? { sessionName: options.sessionName } : {}),
        subagent: options.subagent === true,
        hiddenFromList: options.hiddenFromList === true || options.subagent === true,
      });
    }
    return registered;
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
      if (this.lifecycle.has(status.sessionId)) continue;
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

  async listSessions(cwd?: string, options: ListSessionsOptions = {}): Promise<readonly SessionListItem[]> {
    const allowedCwd = cwd === undefined ? undefined : this.pathPolicy.assertAllowedCwd(cwd);
    const sessions = await this.adapter.listSessions(allowedCwd, options);
    return sessions.filter((session) => {
      if (!options.includeHidden && session.hiddenFromList) return false;
      if (!options.includeSubagents && session.subagent) return false;
      return this.isSearchableSession(session.cwd, session.sessionFile);
    });
  }

  /** Shared policy gate for session listing and the durable transcript index. */
  isSearchableSession(cwd: string, sessionFile: string): boolean {
    try {
      this.assertSearchableSession(cwd, sessionFile);
      return true;
    } catch {
      return false;
    }
  }

  assertSearchableSession(cwd: string, sessionFile: string): void {
    this.pathPolicy.assertAllowedCwd(cwd);
    this.pathPolicy.assertAllowedSessionFile(sessionFile);
  }

  hasSession(sessionId: string): boolean {
    return this.lifecycle.has(sessionId);
  }

  /**
   * Return every locally attached session so callers can overlay live workers
   * on durable indexes that intentionally defer active transcript writes.
   */
  listRegisteredSessions(options: ListSessionsOptions = {}): readonly RegisteredSession[] {
    return this.lifecycle.list()
      .filter((session) => (options.includeHidden || !session.hiddenFromList) && (options.includeSubagents || !session.subagent));
  }

  getSession(sessionId: string): RegisteredSession {
    return this.lifecycle.get(sessionId);
  }

  /**
   * Self-healing primitive (Feature B). True iff the session has a registered
   * handle whose underlying worker connection is still open. A handle becomes
   * unhealthy when its detached supervisor dies (crash/OOM/kill): the unix
   * socket fires 'close', the handle marks itself closed, and every later
   * request throws "supervisor connection is closed". The request path asks
   * this before serving a handle and, on false, evicts + re-opens so the
   * session transparently self-heals instead of being stuck at 500/ENOENT
   * until the API is bounced.
   */
  isSessionHealthy(sessionId: string): boolean {
    return this.lifecycle.isHealthy(sessionId);
  }

  /**
   * Forget a session whose worker is already gone. Unlike disposeSession this
   * does NOT RPC-shutdown the (dead) worker; it tears down the local
   * subscription/ring, best-effort closes the dead handle's socket, and prunes
   * the stale on-disk status + orphan socket so a fresh open spawns cleanly.
   * Safe to call on an unknown id. Returns true if a session was evicted.
   */
  async evictDeadSession(sessionId: string): Promise<boolean> {
    if (!this.lifecycle.has(sessionId)) return false;
    const registered = this.lifecycle.closeEvents(sessionId);
    const handle = registered.handle;
    if (typeof handle.detach === "function") {
      await handle.detach().catch(() => undefined);
    }
    this.lifecycle.forget(sessionId);
    this.pendingSessionMetadata.delete(sessionId);
    await this.workerRegistry.removeSession(sessionId).catch(() => undefined);
    return true;
  }

  async prompt(sessionId: string, message: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    const registered = this.getSession(sessionId);
    await registered.handle.prompt(message, attachments);
    await this.persistPendingSessionMetadata(registered);
  }

  async abort(sessionId: string): Promise<void> {
    await this.getSession(sessionId).handle.abort();
  }

  async compact(sessionId: string, customInstructions?: string): Promise<unknown> {
    const handle = this.getSession(sessionId).handle;
    if (!handle.compact) throw new Error("Session adapter does not support compaction");
    return handle.compact(customInstructions);
  }

  async getCommands(sessionId: string) {
    const handle = this.getSession(sessionId).handle;
    if (!handle.getCommands) return [];
    return sanitizePiDynamicCommands(await handle.getCommands());
  }

  async runPiSlashCommand(sessionId: string, text: string): Promise<void> {
    if (!text.startsWith("/") || text === "/" || /^\/\s/.test(text)) throw new Error("Expected a slash command");
    const handle = this.getSession(sessionId).handle;
    if (!handle.runPiSlashCommand) throw new Error("Session adapter does not support generic Pi slash commands");
    await handle.runPiSlashCommand(text);
  }

  async reloadSession(sessionId: string): Promise<RegisteredSession> {
    const registered = this.getSession(sessionId);
    if (!registered.handle.reload) throw new Error("Session adapter does not support reload");
    const oldId = registered.handle.id;
    await registered.handle.reload();
    // Re-register even when the session id is unchanged: a Pi RPC restart
    // resets the supervisor event sequence, so the registry must reset its
    // per-session ring/seq state while preserving active subscribers.
    return this.replaceSessionId(oldId, registered.handle);
  }

  async setSessionName(sessionId: string, name: string): Promise<SessionState> {
    return this.getSession(sessionId).handle.setSessionName(name);
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const byKey = new Map<string, ModelInfo>();
    for (const session of this.lifecycle.list()) {
      const liveModels = session.handle.getAvailableModels
        ? await session.handle.getAvailableModels().catch(() => [])
        : [];
      for (const model of liveModels) byKey.set(`${model.provider}/${model.id}`, model);
    }
    for (const model of await this.adapter.listModels()) {
      const key = `${model.provider}/${model.id}`;
      if (!byKey.has(key)) byKey.set(key, model);
    }
    return [...byKey.values()];
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
    return this.lifecycle.subscribe(sessionId, listener);
  }

  /** Observe events from every registered session without consuming a client
   * subscription slot. Observers are best-effort and must never break Pi's
   * realtime event fanout. */
  subscribeAll(listener: (session: RegisteredSession, event: PiEvent) => void): () => void {
    return this.lifecycle.subscribeAll(listener);
  }

  subscribeWithSeq(sessionId: string, listener: SeqEventListener): () => void {
    return this.lifecycle.subscribeWithSeq(sessionId, listener);
  }

  /**
   * Replay buffered events with seq > fromSeq, then subscribe live. If
   * fromSeq points to a seq older than the ring's lowest seq the listener
   * first receives a synthetic session_resync event so the client knows it
   * has missed history and should refetch state.
   */
  subscribeFromSeq(sessionId: string, fromSeq: number | null, listener: SeqEventListener): () => void {
    return this.lifecycle.subscribeFromSeq(sessionId, fromSeq, listener);
  }

  /** Greatest seq delivered for a session (0 if nothing emitted yet). */
  lastSeq(sessionId: string): number {
    return this.lifecycle.lastSeq(sessionId);
  }

  /** Number of live realtime subscribers for a session. Used by the realtime
   *  gateway's leak tests and operator health snapshots. */
  subscriberCount(sessionId: string): number {
    return this.lifecycle.subscriberCount(sessionId);
  }

  /** Explicit session delete: RPC-shutdown the worker and forget. */
  async disposeSession(sessionId: string): Promise<void> {
    const registered = this.lifecycle.closeEvents(sessionId);
    await registered.handle.dispose();
    this.lifecycle.forget(sessionId);
    this.pendingSessionMetadata.delete(sessionId);
  }

  /** API shutdown: close the socket but keep the worker (supervisor) alive. */
  async detachSession(sessionId: string): Promise<void> {
    const registered = this.lifecycle.closeEvents(sessionId);
    if (registered.handle.detach) await registered.handle.detach();
    else await registered.handle.dispose();
    this.lifecycle.forget(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const registered = this.lifecycle.closeEvents(sessionId);
    await registered.handle.dispose();
    this.lifecycle.forget(sessionId);
    this.pendingSessionMetadata.delete(sessionId);
    await fs.rm(registered.sessionFile, { force: true });
    await fs.rm(transcriptSidecarDirectory(registered.sessionFile), { recursive: true, force: true });
    await this.workerRegistry.removeSession(sessionId);
  }

  async disposeAll(): Promise<void> {
    const ids = this.lifecycle.list().map((session) => session.id);
    await Promise.all(ids.map((id) => this.disposeSession(id)));
  }

  /** Called on API SIGTERM/SIGINT. Closes sockets without killing workers. */
  async detachAll(): Promise<void> {
    const ids = this.lifecycle.list().map((session) => session.id);
    await Promise.all(ids.map((id) => this.detachSession(id).catch(() => undefined)));
  }

  private async persistPendingSessionMetadata(registered: RegisteredSession): Promise<void> {
    const metadata = this.pendingSessionMetadata.get(registered.id);
    if (!metadata) return;
    // Pi owns initial JSONL creation. Once prompt() resolves, it has completed
    // the child turn (including an error turn), so the file is safe to append.
    await appendHiddenSessionMetadata(registered.sessionFile, metadata);
    this.pendingSessionMetadata.delete(registered.id);
  }

  private register(handle: PiSessionHandle, metadata: Pick<CreateSessionOptions, "subagent" | "hiddenFromList"> = {}): RegisteredSession {
    return this.lifecycle.attach(handle, metadata);
  }

  private observeSessionEvent(registered: RegisteredSession, event: PiEvent): void {
    // Pi owns JSONL persistence. Sidecar work must never delay realtime delivery.
    if (event.type === "agent_end") {
      void persistOversizedTranscriptBodies(registered.sessionFile).catch(() => undefined);
    }
    // SessionLifecycle invokes process-wide observers after this hook returns.
  }

  private replaceSessionId(oldSessionId: string, handle: PiSessionHandle): RegisteredSession {
    // Transfer any remaining subscribers to the replacement stream so SSE
    // clients survive clone/reload identity changes.
    return this.lifecycle.replace(oldSessionId, handle);
  }
}
