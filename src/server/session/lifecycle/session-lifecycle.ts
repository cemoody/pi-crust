import type {
  CreateSessionOptions,
  PiEvent,
  PiEventListener,
  PiSessionHandle,
  SeqEventListener,
  Unsubscribe,
} from "../../pi/types.js";
import { SessionEventStream } from "../session-event-stream.js";

/** A live Pi handle plus the immutable identity used by all session callers. */
export interface RegisteredSession {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly handle: PiSessionHandle;
  readonly subagent?: boolean;
  readonly hiddenFromList?: boolean;
}

export interface SessionHealthSnapshot {
  readonly total: number;
  readonly healthy: number;
  readonly broken: number;
  readonly brokenSessionIds: string[];
}

export interface SessionLifecycleOptions {
  readonly eventRingSize: number;
  /** Invoked after a live event reaches the replay ring and subscribers. */
  readonly onEvent?: (session: RegisteredSession, event: PiEvent) => void;
}

interface SessionInternal {
  readonly registered: RegisteredSession;
  readonly eventStream: SessionEventStream;
}

/**
 * Owns the in-memory lifecycle of attached Pi sessions.
 *
 * This is the sole owner of handle-to-event-stream wiring, replay state,
 * subscribers, observers, replacement, and teardown. SessionRegistry owns
 * adapter calls, path policy, persistence, and worker cleanup; it delegates
 * every hot-session state transition here.
 */
export class SessionLifecycle {
  private readonly sessions = new Map<string, SessionInternal>();
  private readonly eventObservers = new Set<(session: RegisteredSession, event: PiEvent) => void>();
  private readonly ringSize: number;
  private readonly onEvent: ((session: RegisteredSession, event: PiEvent) => void) | undefined;

  constructor(options: SessionLifecycleOptions) {
    this.ringSize = options.eventRingSize;
    this.onEvent = options.onEvent;
  }

  get count(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): RegisteredSession {
    return this.getInternal(sessionId).registered;
  }

  list(): readonly RegisteredSession[] {
    return [...this.sessions.values()].map((session) => session.registered);
  }

  attach(handle: PiSessionHandle, metadata: Pick<CreateSessionOptions, "subagent" | "hiddenFromList"> = {}): RegisteredSession {
    const registered: RegisteredSession = {
      id: handle.id,
      cwd: handle.cwd,
      sessionFile: handle.sessionFile,
      handle,
      ...(metadata.subagent ? { subagent: true } : {}),
      ...(metadata.hiddenFromList || metadata.subagent ? { hiddenFromList: true } : {}),
    };
    const eventStream = new SessionEventStream({
      handle,
      ringSize: this.ringSize,
      onEvent: (event) => this.observe(registered, event),
    });
    this.sessions.set(handle.id, { registered, eventStream });
    return registered;
  }

  /** Stop a session's realtime stream while retaining its handle identity. */
  closeEvents(sessionId: string): RegisteredSession {
    const internal = this.getInternal(sessionId);
    internal.eventStream.close();
    return internal.registered;
  }

  /** Remove a session after its caller has completed the handle lifecycle operation. */
  forget(sessionId: string): RegisteredSession {
    const internal = this.getInternal(sessionId);
    this.sessions.delete(sessionId);
    return internal.registered;
  }

  /**
   * Replace a handle after reload/clone while transferring live subscribers
   * to the new stream. Replay state intentionally resets with the Pi handle.
   */
  replace(oldSessionId: string, handle: PiSessionHandle): RegisteredSession {
    const old = this.sessions.get(oldSessionId);
    this.sessions.delete(oldSessionId);
    if (old) old.eventStream.unsubscribe();
    const registered = this.attach(handle);
    if (old) old.eventStream.transferSubscribersTo(this.getInternal(handle.id).eventStream);
    return registered;
  }

  healthSnapshot(): SessionHealthSnapshot {
    let healthy = 0;
    let broken = 0;
    const brokenSessionIds: string[] = [];
    for (const [sessionId, internal] of this.sessions) {
      if (isHealthy(internal.registered.handle)) healthy += 1;
      else { broken += 1; brokenSessionIds.push(sessionId); }
    }
    return { total: this.sessions.size, healthy, broken, brokenSessionIds };
  }

  isHealthy(sessionId: string): boolean {
    const internal = this.sessions.get(sessionId);
    return internal ? isHealthy(internal.registered.handle) : false;
  }

  subscribe(sessionId: string, listener: PiEventListener): Unsubscribe {
    return this.getInternal(sessionId).eventStream.subscribe((event) => listener(event));
  }

  subscribeWithSeq(sessionId: string, listener: SeqEventListener): Unsubscribe {
    return this.getInternal(sessionId).eventStream.subscribe(listener);
  }

  subscribeFromSeq(sessionId: string, fromSeq: number | null, listener: SeqEventListener): Unsubscribe {
    return this.getInternal(sessionId).eventStream.subscribeFromSeq(fromSeq, listener);
  }

  lastSeq(sessionId: string): number {
    return this.getInternal(sessionId).eventStream.lastSeq;
  }

  subscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.eventStream.subscriberCount ?? 0;
  }

  subscribeAll(listener: (session: RegisteredSession, event: PiEvent) => void): Unsubscribe {
    this.eventObservers.add(listener);
    return () => this.eventObservers.delete(listener);
  }

  private getInternal(sessionId: string): SessionInternal {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private observe(session: RegisteredSession, event: PiEvent): void {
    try { this.onEvent?.(session, event); } catch { /* lifecycle hooks must not break realtime delivery */ }
    for (const observer of this.eventObservers) {
      try { observer(session, event); } catch { /* observers must not break realtime delivery */ }
    }
  }
}

function isHealthy(handle: PiSessionHandle): boolean {
  return typeof handle.isHealthy === "function" ? handle.isHealthy() : true;
}
