/**
 * Deterministic, DOM-free fakes for exercising the client-side multiplexed
 * realtime connection (src/web/api/realtime-connection.ts) before it is wired
 * into the browser. Lets unit tests drive connect/disconnect, server events,
 * acks, page-visibility, and cross-tab BroadcastChannel traffic by hand.
 */
import type { BroadcastLike, RealtimeTransport, VisibilitySource } from "../../src/web/api/realtime-connection.js";

interface EmittedMessage {
  readonly event: string;
  readonly payload: unknown;
  readonly ack?: (response: unknown) => void;
}

/**
 * Socket.IO-shaped fake. Connection state and inbound events are driven
 * explicitly via simulate*; outbound emits are recorded for assertions. By
 * default a `session:subscribe` ack resolves `{ ok:true, lastSeq }` using the
 * configurable ackLastSeq map so resume math is testable.
 */
export class FakeTransport implements RealtimeTransport {
  connected = false;
  readonly emitted: EmittedMessage[] = [];
  readonly ackLastSeq = new Map<string, number>();
  ackOkDefault = true;
  /** When true, `session:subscribe` acks are withheld (ack-timeout tests). */
  withholdAcks = false;
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  /** How many times connect() has been called (reconnect accounting). */
  connectCalls = 0;
  disconnectCalls = 0;

  on(event: string, handler: (...args: unknown[]) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload: unknown, ack?: (response: unknown) => void): void {
    this.emitted.push({ event, payload, ...(ack ? { ack } : {}) });
    // Auto-ack subscribe/unsubscribe so the client's resume bookkeeping runs.
    if (ack && this.withholdAcks) {
      return; // simulate a server that accepted the socket but never acks
    }
    if (ack && event === "session:subscribe") {
      const sessionId = (payload as { sessionId?: string })?.sessionId ?? "";
      ack(this.ackOkDefault
        ? { ok: true, sessionId, lastSeq: this.ackLastSeq.get(sessionId) ?? 0 }
        : { ok: false, error: `unknown session: ${sessionId}` });
    } else if (ack && event === "session:unsubscribe") {
      ack({ ok: true });
    }
  }

  connect(): void { this.connectCalls += 1; }
  disconnect(): void { this.disconnectCalls += 1; this.simulateDisconnect(); }

  // ---- test drivers --------------------------------------------------------
  simulateConnect(): void {
    this.connected = true;
    this.fire("connect");
  }

  simulateDisconnect(reason = "transport close"): void {
    if (!this.connected) return;
    this.connected = false;
    this.fire("disconnect", reason);
  }

  /** A failed connection attempt (engine.io `connect_error`). */
  simulateConnectError(error: Error = new Error("connect_error")): void {
    this.connected = false;
    this.fire("connect_error", error);
  }

  /** A transport-level error while connected. */
  simulateError(error: Error = new Error("transport error")): void {
    this.fire("error", error);
  }

  /** Deliver a server `session:event` envelope. */
  simulateSessionEvent(sessionId: string, seq: number, event: unknown): void {
    this.fire("session:event", { sessionId, seq, event });
  }

  /** Most recent emit for an event name (or undefined). */
  lastEmit(event: string): EmittedMessage | undefined {
    for (let i = this.emitted.length - 1; i >= 0; i -= 1) {
      if (this.emitted[i]!.event === event) return this.emitted[i];
    }
    return undefined;
  }

  emitsOf(event: string): EmittedMessage[] {
    return this.emitted.filter((m) => m.event === event);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

/** In-memory BroadcastChannel bus: every channel created from one hub sees the
 *  others' postMessage calls (never its own), mirroring real BroadcastChannel. */
export class FakeBroadcastHub {
  private readonly channels = new Set<FakeBroadcastChannel>();

  create(): FakeBroadcastChannel {
    const channel = new FakeBroadcastChannel(this.channels);
    this.channels.add(channel);
    return channel;
  }
}

export class FakeBroadcastChannel implements BroadcastLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private closed = false;
  constructor(private readonly peers: Set<FakeBroadcastChannel>) {}

  postMessage(message: unknown): void {
    if (this.closed) return;
    // Async like the real thing, so leader handoff ordering is realistic.
    queueMicrotask(() => {
      for (const peer of this.peers) {
        if (peer === this || peer.closed) continue;
        peer.onmessage?.({ data: message });
      }
    });
  }

  close(): void { this.closed = true; this.peers.delete(this); }
}

/** Controllable page-visibility source. */
export class FakeVisibility implements VisibilitySource {
  private visible = true;
  private readonly listeners = new Set<() => void>();

  isVisible(): boolean { return this.visible; }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  set(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const listener of this.listeners) listener();
  }
}

/** Flush pending microtasks (BroadcastChannel delivery). */
export async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
