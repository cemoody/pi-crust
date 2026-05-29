/**
 * Client-side multiplexed realtime connection (Option B, browser side).
 *
 * Backs SessionDashboardApi.streamEvents. Instead of one EventSource per
 * session/tab, it owns ONE transport per origin and multiplexes every logical
 * session subscription over it, with reconnect/resume, dedup, and optional
 * cross-tab BroadcastChannel leader election so N tabs share ONE socket.
 *
 * Contracts: tests/unit/realtime-connection.test.ts,
 * tests/unit/realtime-leader-election.test.ts,
 * tests/e2e/realtime-client-gateway.test.ts.
 */

export interface RealtimeTransport {
  readonly connected: boolean;
  connect(): void;
  disconnect(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, payload: unknown, ack?: (response: unknown) => void): void;
}

export interface VisibilitySource {
  isVisible(): boolean;
  subscribe(onChange: () => void): () => void;
}

export interface BroadcastLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface RealtimeClientEvent {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface RealtimeConnectionOptions {
  readonly transportFactory: () => RealtimeTransport;
  readonly tabId?: string;
  readonly broadcast?: BroadcastLike;
  readonly visibility?: VisibilitySource;
  readonly idleCloseMs?: number;
  readonly maxConnectErrorsBeforeFallback?: number;
  readonly onFallback?: (reason: string) => void;
  readonly ackTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly leaderTimeoutMs?: number;
  readonly now?: () => number;
  readonly onClientEvent?: (event: RealtimeClientEvent) => void;
}

export interface RealtimeConnection {
  subscribe(sessionId: string, onEvent: (event: unknown) => void, options?: { readonly fromSeq?: number | null }): () => void;
  readonly connectionCount: number;
  readonly activeSubscriptions: number;
  readonly isLeader: boolean;
  /** Register a callback fired once when the connection gives up (sticky). */
  onFallback(cb: (reason: string) => void): void;
  dispose(): void;
}

type Role = "candidate" | "leader" | "follower" | "disposed";

interface ChannelMessage {
  readonly t: "hello" | "claim" | "heartbeat" | "bye" | "want" | "unwant" | "event";
  readonly tabId?: string;
  readonly joinedAt?: number;
  readonly sessionId?: string;
  readonly fromSeq?: number | null;
  readonly seq?: number;
  readonly event?: unknown;
}

const CONTROL_TYPES = new Set(["session_resync", "stream_reconnected", "stream_unavailable"]);

export function createRealtimeConnection(options: RealtimeConnectionOptions): RealtimeConnection {
  return new RealtimeConnectionImpl(options);
}

class RealtimeConnectionImpl implements RealtimeConnection {
  private readonly tabId: string;
  private readonly joinedAt: number;
  private readonly now: () => number;
  private readonly idleCloseMs: number;
  private readonly maxConnectErrors: number;
  private readonly ackTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly leaderTimeoutMs: number;

  private role: Role;
  private transport: RealtimeTransport | null = null;
  private everConnected = false;
  private connectErrors = 0;
  private fellBack = false;
  private paused = false;
  private readonly fallbackCbs = new Set<(reason: string) => void>();

  /** Local listeners per session (this tab's callers). */
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  /** Highest seq delivered per session (dedup + resume). */
  private readonly lastSeq = new Map<string, number>();
  /** Sessions currently subscribed on the live transport. */
  private readonly wireActive = new Set<string>();
  /** Pending ack timers per session. */
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Leader-only: which follower tabs want each session. */
  private readonly remoteWants = new Map<string, Set<string>>();
  private knownLeader: { tabId: string; joinedAt: number } | null = null;
  private lastLeaderBeatAt = 0;
  private idleSince: number | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly disposeVisibility: (() => void) | null = null;

  private readonly onConnect = () => this.handleConnect();
  private readonly onDisconnect = () => this.handleDisconnect();
  private readonly onConnectError = () => this.handleConnectError();
  private readonly onTransportError = (...args: unknown[]) => {
    this.emitClient({ kind: "realtime-transport-error", error: String(args[0] ?? "error") });
  };
  private readonly onSessionEvent = (...args: unknown[]) => {
    const envelope = args[0] as { sessionId?: string; seq?: number; event?: unknown } | undefined;
    if (envelope?.sessionId) this.handleIncoming(envelope.sessionId, envelope.seq, envelope.event);
  };

  constructor(private readonly options: RealtimeConnectionOptions) {
    // `||` (not `??`): an empty string from getTabSessionId() must still get a
    // unique id, or two tabs share tabId "" and leader election can't tell them
    // apart (each ignores the other's claim, so no tab ever steps down).
    this.tabId = options.tabId || `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    this.now = options.now ?? (() => Date.now());
    this.joinedAt = this.now();
    this.idleCloseMs = options.idleCloseMs ?? 15_000;
    this.maxConnectErrors = options.maxConnectErrorsBeforeFallback ?? 3;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000;
    this.heartbeatMs = options.heartbeatMs ?? 2_000;
    this.leaderTimeoutMs = options.leaderTimeoutMs ?? 5_000;

    if (options.broadcast) {
      this.role = "candidate";
      options.broadcast.onmessage = (e) => this.handleChannel(e.data as ChannelMessage);
      this.post({ t: "hello", tabId: this.tabId, joinedAt: this.joinedAt });
      // Race for leadership: candidates open a transport and try to connect.
      this.openTransport();
      this.startLiveness();
    } else {
      // Single-tab: always leader; open lazily on first subscribe.
      this.role = "leader";
    }

    if (options.visibility) {
      this.disposeVisibility = options.visibility.subscribe(() => this.handleVisibility());
    }
  }

  get connectionCount(): number {
    this.reconcileIdle();
    return this.transport ? 1 : 0;
  }

  get activeSubscriptions(): number {
    this.reconcileIdle();
    return this.listeners.size;
  }

  get isLeader(): boolean {
    return this.role === "leader";
  }

  onFallback(cb: (reason: string) => void): void {
    this.fallbackCbs.add(cb);
  }

  subscribe(sessionId: string, onEvent: (event: unknown) => void, opts?: { readonly fromSeq?: number | null }): () => void {
    if (this.role === "disposed") return () => {};
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(onEvent);
    this.listeners.set(sessionId, set);
    if (opts?.fromSeq != null && !this.lastSeq.has(sessionId)) this.lastSeq.set(sessionId, opts.fromSeq);
    this.idleSince = null;

    if (this.role === "leader") {
      this.ensureTransport();
      this.ensureWire(sessionId);
    } else if (this.role === "follower") {
      this.post({ t: "want", tabId: this.tabId, sessionId, fromSeq: this.lastSeq.get(sessionId) ?? null });
    }
    // candidate: nothing yet; flushed once leadership resolves.

    return () => this.removeListener(sessionId, onEvent);
  }

  dispose(): void {
    if (this.role === "disposed") return;
    if (this.options.broadcast) this.post({ t: "bye", tabId: this.tabId });
    this.role = "disposed";
    this.stopHeartbeat();
    if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    for (const timer of this.ackTimers.values()) clearTimeout(timer);
    this.ackTimers.clear();
    this.closeTransport();
    this.listeners.clear();
    this.disposeVisibility?.();
    if (this.options.broadcast) { this.options.broadcast.onmessage = null; this.options.broadcast.close(); }
  }

  // ---- transport lifecycle -------------------------------------------------

  private ensureTransport(): void {
    if (this.fellBack || this.paused) return;
    this.openTransport();
  }

  private openTransport(): void {
    if (this.transport || this.fellBack) return;
    const transport = this.options.transportFactory();
    this.transport = transport;
    transport.on("connect", this.onConnect);
    transport.on("disconnect", this.onDisconnect);
    transport.on("connect_error", this.onConnectError);
    transport.on("error", this.onTransportError);
    transport.on("session:event", this.onSessionEvent);
    transport.connect();
  }

  private closeTransport(): void {
    const transport = this.transport;
    if (!transport) return;
    transport.off("connect", this.onConnect);
    transport.off("disconnect", this.onDisconnect);
    transport.off("connect_error", this.onConnectError);
    transport.off("error", this.onTransportError);
    transport.off("session:event", this.onSessionEvent);
    try { transport.disconnect(); } catch { /* ignore */ }
    this.transport = null;
    this.wireActive.clear();
  }

  private handleConnect(): void {
    this.connectErrors = 0;
    const isReconnect = this.everConnected;
    this.everConnected = true;

    if (this.options.broadcast && this.role !== "leader") this.claimLeadership();
    if (this.role !== "leader" && !this.options.broadcast) this.role = "leader";

    this.wireActive.clear();
    for (const sessionId of this.wantedSessions()) {
      this.ensureWire(sessionId);
      if (isReconnect) this.fanout(sessionId, -1, { type: "stream_reconnected", reason: "reconnect" });
    }
  }

  private handleDisconnect(): void {
    this.wireActive.clear();
    // Pending subscribes are void once the socket drops; cancel their ack
    // timers so a reconnect doesn't double-arm and fire a phantom timeout.
    for (const timer of this.ackTimers.values()) clearTimeout(timer);
    this.ackTimers.clear();
  }

  private handleConnectError(): void {
    if (this.fellBack) return;
    this.connectErrors += 1;
    if (this.connectErrors >= this.maxConnectErrors) {
      this.fellBack = true;
      this.emitClient({ kind: "realtime-fallback", reason: "connect-error-threshold" });
      this.closeTransport();
      this.options.onFallback?.("connect-error-threshold");
      for (const cb of [...this.fallbackCbs]) { try { cb("connect-error-threshold"); } catch { /* ignore */ } }
    }
  }

  // ---- wire subscription management ---------------------------------------

  private wantedSessions(): Set<string> {
    const wanted = new Set<string>(this.listeners.keys());
    for (const [sessionId, tabs] of this.remoteWants) if (tabs.size > 0) wanted.add(sessionId);
    return wanted;
  }

  private ensureWire(sessionId: string): void {
    if (this.role !== "leader") return;
    // A want may arrive after an idle close; make sure the socket is back.
    this.ensureTransport();
    const transport = this.transport;
    if (!transport || !transport.connected) return; // connect handler will subscribe
    if (this.wireActive.has(sessionId)) return;
    this.wireActive.add(sessionId);
    const fromSeq = this.lastSeq.has(sessionId) ? this.lastSeq.get(sessionId)! : null;
    const timer = setTimeout(() => {
      this.ackTimers.delete(sessionId);
      this.emitClient({ kind: "realtime-subscribe-timeout", sessionId });
    }, this.ackTimeoutMs);
    this.ackTimers.set(sessionId, timer);
    transport.emit("session:subscribe", { sessionId, fromSeq }, (ack: unknown) => {
      const pending = this.ackTimers.get(sessionId);
      if (pending) { clearTimeout(pending); this.ackTimers.delete(sessionId); }
      const ok = (ack as { ok?: boolean } | undefined)?.ok;
      if (ok === false) {
        this.wireActive.delete(sessionId);
        const error = (ack as { error?: string }).error;
        this.emitClient({ kind: "realtime-subscribe-rejected", sessionId, error });
        // Tell this session's listeners the realtime path is unavailable so the
        // streamer can fall just this session back to SSE (socket stays up).
        this.fanout(sessionId, -1, { type: "stream_unavailable", reason: "subscribe-rejected", error });
      }
    });
  }

  private dropWire(sessionId: string): void {
    if (this.role !== "leader") return;
    const transport = this.transport;
    if (this.wireActive.delete(sessionId) && transport && transport.connected) {
      transport.emit("session:unsubscribe", { sessionId });
    }
    const pending = this.ackTimers.get(sessionId);
    if (pending) { clearTimeout(pending); this.ackTimers.delete(sessionId); }
  }

  private removeListener(sessionId: string, onEvent: (event: unknown) => void): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    set.delete(onEvent);
    if (set.size > 0) return;
    this.listeners.delete(sessionId);
    if (this.role === "follower") {
      this.post({ t: "unwant", tabId: this.tabId, sessionId });
    } else if (this.role === "leader" && !this.isWanted(sessionId)) {
      this.dropWire(sessionId);
    }
    if (this.wantedSessions().size === 0) {
      this.idleSince = this.now();
      this.scheduleIdleClose();
    }
  }

  private isWanted(sessionId: string): boolean {
    if (this.listeners.has(sessionId)) return true;
    const tabs = this.remoteWants.get(sessionId);
    return !!tabs && tabs.size > 0;
  }

  // ---- event delivery + dedup ----------------------------------------------

  private handleIncoming(sessionId: string, seq: number | undefined, event: unknown): void {
    if (!this.dedup(sessionId, seq, event)) return;
    this.fanout(sessionId, seq ?? -1, event, true);
  }

  /** Returns false if this is a duplicate that should be dropped. */
  private dedup(sessionId: string, seq: number | undefined, event: unknown): boolean {
    const type = (event as { type?: string } | undefined)?.type;
    if (type && CONTROL_TYPES.has(type)) return true;
    if (typeof seq === "number") {
      if (seq <= (this.lastSeq.get(sessionId) ?? 0)) return false;
      this.lastSeq.set(sessionId, seq);
    }
    return true;
  }

  /** Deliver to local listeners and (leader) broadcast to follower tabs. */
  private fanout(sessionId: string, seq: number, event: unknown, fromWire = false): void {
    const set = this.listeners.get(sessionId);
    if (set) for (const fn of [...set]) { try { fn(event); } catch { /* listener errors isolated */ } }
    if (this.role === "leader" && this.options.broadcast) {
      this.post({ t: "event", sessionId, seq, event });
    }
    void fromWire;
  }

  // ---- cross-tab leader election -------------------------------------------

  private handleChannel(msg: ChannelMessage): void {
    if (this.role === "disposed" || !msg) return;
    switch (msg.t) {
      case "hello":
        // A new peer appeared; if we're leader, re-assert so it can defer.
        if (this.role === "leader") this.post({ t: "claim", tabId: this.tabId, joinedAt: this.joinedAt });
        break;
      case "claim":
      case "heartbeat":
        this.observeLeader(msg.tabId!, msg.joinedAt ?? 0);
        break;
      case "bye":
        if (this.knownLeader?.tabId === msg.tabId) {
          this.knownLeader = null;
          this.becomeCandidate();
        }
        this.remoteWantsForgetTab(msg.tabId!);
        break;
      case "want":
        if (this.role === "leader" && msg.sessionId) {
          const tabs = this.remoteWants.get(msg.sessionId) ?? new Set();
          tabs.add(msg.tabId!);
          this.remoteWants.set(msg.sessionId, tabs);
          if (msg.fromSeq != null && !this.lastSeq.has(msg.sessionId)) this.lastSeq.set(msg.sessionId, msg.fromSeq);
          this.idleSince = null;
          this.ensureWire(msg.sessionId);
        }
        break;
      case "unwant":
        if (this.role === "leader" && msg.sessionId) {
          this.remoteWants.get(msg.sessionId)?.delete(msg.tabId!);
          if (!this.isWanted(msg.sessionId)) this.dropWire(msg.sessionId);
          if (this.wantedSessions().size === 0) { this.idleSince = this.now(); this.scheduleIdleClose(); }
        }
        break;
      case "event":
        if (msg.sessionId) this.handleIncoming(msg.sessionId, msg.seq, msg.event);
        break;
    }
  }

  private observeLeader(tabId: string, joinedAt: number): void {
    if (tabId === this.tabId) return;
    const candidate = { tabId, joinedAt };
    const betterThanMe = this.priorityLess(candidate, { tabId: this.tabId, joinedAt: this.joinedAt });
    if (this.role === "leader") {
      if (betterThanMe) this.stepDown(candidate); // another tab outranks us
      return;
    }
    // follower/candidate: accept this leader if it outranks our current known.
    if (!this.knownLeader || this.priorityLess(candidate, this.knownLeader) || candidate.tabId === this.knownLeader.tabId) {
      const wasUnknown = !this.knownLeader;
      this.knownLeader = candidate;
      this.lastLeaderBeatAt = this.now();
      if (this.role !== "follower" || wasUnknown) this.becomeFollower();
    }
  }

  private priorityLess(a: { tabId: string; joinedAt: number }, b: { tabId: string; joinedAt: number }): boolean {
    if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt;
    return a.tabId < b.tabId;
  }

  private claimLeadership(): void {
    // Only claim if no live leader outranks us.
    if (this.knownLeader && this.priorityLess(this.knownLeader, { tabId: this.tabId, joinedAt: this.joinedAt })) {
      this.becomeFollower();
      return;
    }
    this.role = "leader";
    this.knownLeader = { tabId: this.tabId, joinedAt: this.joinedAt };
    this.post({ t: "claim", tabId: this.tabId, joinedAt: this.joinedAt });
    this.startHeartbeat();
  }

  private stepDown(newLeader: { tabId: string; joinedAt: number }): void {
    this.role = "follower";
    this.knownLeader = newLeader;
    this.lastLeaderBeatAt = this.now();
    this.stopHeartbeat();
    this.remoteWants.clear();
    this.closeTransport();
    this.flushWants();
  }

  private becomeFollower(): void {
    this.role = "follower";
    this.stopHeartbeat();
    this.closeTransport();
    this.flushWants();
  }

  private becomeCandidate(): void {
    if (this.role === "disposed") return;
    this.role = "candidate";
    this.knownLeader = null;
    // ensureTransport (not openTransport) so a paused/hidden tab does not
    // grab the socket just because the leader went away.
    this.ensureTransport();
  }

  private flushWants(): void {
    for (const sessionId of this.listeners.keys()) {
      this.post({ t: "want", tabId: this.tabId, sessionId, fromSeq: this.lastSeq.get(sessionId) ?? null });
    }
  }

  private remoteWantsForgetTab(tabId: string): void {
    for (const [sessionId, tabs] of this.remoteWants) {
      if (tabs.delete(tabId) && !this.isWanted(sessionId)) this.dropWire(sessionId);
    }
  }

  // ---- timers --------------------------------------------------------------

  private startHeartbeat(): void {
    if (this.heartbeatTimer || !this.options.broadcast) return;
    this.heartbeatTimer = setInterval(() => {
      this.post({ t: "heartbeat", tabId: this.tabId, joinedAt: this.joinedAt });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private startLiveness(): void {
    if (this.livenessTimer || !this.options.broadcast) return;
    this.livenessTimer = setInterval(() => {
      if (this.role === "follower" && this.knownLeader && this.now() - this.lastLeaderBeatAt > this.leaderTimeoutMs) {
        this.knownLeader = null;
        this.becomeCandidate();
      }
    }, Math.max(250, Math.floor(this.heartbeatMs / 2)));
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer || this.idleCloseMs <= 0) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; this.reconcileIdle(); }, this.idleCloseMs);
  }

  private reconcileIdle(): void {
    if (this.role === "disposed") return;
    if (this.transport && this.wantedSessions().size === 0 && this.idleSince !== null && this.now() - this.idleSince >= this.idleCloseMs) {
      this.closeTransport();
    }
  }

  // ---- visibility ----------------------------------------------------------

  private handleVisibility(): void {
    const visible = this.options.visibility?.isVisible() ?? true;
    if (!visible) {
      // A backgrounded LEADER must hand off, or it would hold the only socket
      // while hidden and starve every visible follower tab. Relinquish so a
      // visible follower is promoted; a lone tab simply pauses.
      if (this.role === "leader" && this.options.broadcast) {
        this.post({ t: "bye", tabId: this.tabId });
        this.role = "candidate";
        this.knownLeader = null;
        this.stopHeartbeat();
      }
      this.paused = true;
      this.closeTransport();
    } else {
      this.paused = false;
      if (!this.options.broadcast) this.ensureTransport();
      else this.becomeCandidate(); // rejoin election
    }
  }

  // ---- helpers -------------------------------------------------------------

  private post(message: ChannelMessage): void {
    this.options.broadcast?.postMessage(message);
  }

  private emitClient(event: RealtimeClientEvent): void {
    try { this.options.onClientEvent?.(event); } catch { /* never break on telemetry */ }
  }
}
