import type { BroadcastLike } from "./realtime-connection.js";

export type RealtimeRole = "candidate" | "leader" | "follower" | "disposed";

type ChannelMessage = {
  readonly t: "hello" | "claim" | "heartbeat" | "bye" | "want" | "unwant" | "event";
  readonly tabId?: string;
  readonly joinedAt?: number;
  readonly sessionId?: string;
  readonly fromSeq?: number | null;
  readonly seq?: number;
  readonly event?: unknown;
};

export interface RealtimeLeaderCoordinatorOptions {
  readonly broadcast: BroadcastLike | undefined;
  readonly tabId: string;
  readonly joinedAt: number;
  readonly now: () => number;
  readonly heartbeatMs: number;
  readonly leaderTimeoutMs: number;
  readonly onCandidate: () => void;
  readonly onFollower: () => void;
  readonly onWant: (sessionId: string, tabId: string, fromSeq?: number | null) => void;
  readonly onUnwant: (sessionId: string, tabId: string) => void;
  readonly onForgetTab: (tabId: string) => void;
  readonly onEvent: (sessionId: string, seq: number | undefined, event: unknown) => void;
}

/** Coordinates the BroadcastChannel leader-election protocol for realtime tabs. */
export class RealtimeLeaderCoordinator {
  private roleValue: RealtimeRole;
  private knownLeader: { tabId: string; joinedAt: number } | null = null;
  private lastLeaderBeatAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RealtimeLeaderCoordinatorOptions) {
    this.roleValue = options.broadcast ? "candidate" : "leader";
    if (options.broadcast) {
      options.broadcast.onmessage = (event) => this.handleMessage(event.data as ChannelMessage);
      this.post({ t: "hello", tabId: options.tabId, joinedAt: options.joinedAt });
      this.startLiveness();
    }
  }

  get role(): RealtimeRole {
    return this.roleValue;
  }

  get isLeader(): boolean {
    return this.roleValue === "leader";
  }

  post(message: ChannelMessage): void {
    this.options.broadcast?.postMessage(message);
  }

  claimLeadership(): void {
    const mine = { tabId: this.options.tabId, joinedAt: this.options.joinedAt };
    if (this.knownLeader && this.priorityLess(this.knownLeader, mine)) {
      this.becomeFollower();
      return;
    }
    this.roleValue = "leader";
    this.knownLeader = mine;
    this.post({ t: "claim", ...mine });
    this.startHeartbeat();
  }

  relinquishForHiddenTab(): void {
    if (this.roleValue !== "leader" || !this.options.broadcast) return;
    this.post({ t: "bye", tabId: this.options.tabId });
    this.roleValue = "candidate";
    this.knownLeader = null;
    this.stopHeartbeat();
  }

  rejoinElection(): void {
    if (this.options.broadcast) this.becomeCandidate();
  }

  dispose(): void {
    if (this.roleValue === "disposed") return;
    if (this.options.broadcast) this.post({ t: "bye", tabId: this.options.tabId });
    this.roleValue = "disposed";
    this.stopHeartbeat();
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    if (this.options.broadcast) {
      this.options.broadcast.onmessage = null;
      this.options.broadcast.close();
    }
  }

  private handleMessage(message: ChannelMessage): void {
    if (this.roleValue === "disposed" || !message) return;
    switch (message.t) {
      case "hello":
        if (this.isLeader) this.post({ t: "claim", tabId: this.options.tabId, joinedAt: this.options.joinedAt });
        break;
      case "claim":
      case "heartbeat":
        this.observeLeader(message.tabId!, message.joinedAt ?? 0);
        break;
      case "bye":
        if (this.knownLeader?.tabId === message.tabId) {
          this.knownLeader = null;
          this.becomeCandidate();
        }
        this.options.onForgetTab(message.tabId!);
        break;
      case "want":
        if (this.isLeader && message.sessionId) this.options.onWant(message.sessionId, message.tabId!, message.fromSeq);
        break;
      case "unwant":
        if (this.isLeader && message.sessionId) this.options.onUnwant(message.sessionId, message.tabId!);
        break;
      case "event":
        if (message.sessionId) this.options.onEvent(message.sessionId, message.seq, message.event);
        break;
    }
  }

  private observeLeader(tabId: string, joinedAt: number): void {
    if (tabId === this.options.tabId) return;
    const candidate = { tabId, joinedAt };
    const mine = { tabId: this.options.tabId, joinedAt: this.options.joinedAt };
    if (this.isLeader) {
      if (this.priorityLess(candidate, mine)) this.stepDown(candidate);
      return;
    }
    if (!this.knownLeader || this.priorityLess(candidate, this.knownLeader) || candidate.tabId === this.knownLeader.tabId) {
      const wasUnknown = !this.knownLeader;
      this.knownLeader = candidate;
      this.lastLeaderBeatAt = this.options.now();
      if (this.roleValue !== "follower" || wasUnknown) this.becomeFollower();
    }
  }

  private priorityLess(a: { tabId: string; joinedAt: number }, b: { tabId: string; joinedAt: number }): boolean {
    return a.joinedAt !== b.joinedAt ? a.joinedAt < b.joinedAt : a.tabId < b.tabId;
  }

  private stepDown(newLeader: { tabId: string; joinedAt: number }): void {
    this.roleValue = "follower";
    this.knownLeader = newLeader;
    this.lastLeaderBeatAt = this.options.now();
    this.stopHeartbeat();
    this.options.onFollower();
  }

  private becomeFollower(): void {
    this.roleValue = "follower";
    this.stopHeartbeat();
    this.options.onFollower();
  }

  private becomeCandidate(): void {
    if (this.roleValue === "disposed") return;
    this.roleValue = "candidate";
    this.knownLeader = null;
    this.options.onCandidate();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || !this.options.broadcast) return;
    this.heartbeatTimer = setInterval(() => {
      this.post({ t: "heartbeat", tabId: this.options.tabId, joinedAt: this.options.joinedAt });
    }, this.options.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private startLiveness(): void {
    if (this.livenessTimer || !this.options.broadcast) return;
    this.livenessTimer = setInterval(() => {
      if (this.roleValue === "follower" && this.knownLeader && this.options.now() - this.lastLeaderBeatAt > this.options.leaderTimeoutMs) {
        this.knownLeader = null;
        this.becomeCandidate();
      }
    }, Math.max(250, Math.floor(this.options.heartbeatMs / 2)));
  }
}
