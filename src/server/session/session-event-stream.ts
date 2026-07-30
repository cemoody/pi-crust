import type { PiEvent, PiSessionHandle, SeqEventListener, Unsubscribe } from "../pi/types.js";

interface RingEntry {
  readonly seq: number;
  readonly event: PiEvent;
}

export interface SessionEventStreamOptions {
  readonly handle: PiSessionHandle;
  readonly ringSize: number;
  readonly onEvent?: (event: PiEvent) => void;
}

/**
 * Owns one session handle's event subscription, replay ring, and listeners.
 * Keeping this state together makes handle replacement and teardown atomic.
 */
export class SessionEventStream {
  private readonly ring: RingEntry[] = [];
  private readonly subscribers = new Set<SeqEventListener>();
  private unsubscribeHandle: Unsubscribe;
  private nextLocalSeq = 1;
  private currentLastSeq = 0;

  constructor({ handle, ringSize, onEvent }: SessionEventStreamOptions) {
    const receive = (event: PiEvent, seq: number) => this.receive(event, seq, ringSize, onEvent);
    this.unsubscribeHandle = handle.subscribeWithSeq
      ? handle.subscribeWithSeq(receive)
      : handle.subscribe((event) => receive(event, this.nextLocalSeq++));
  }

  subscribe(listener: SeqEventListener): Unsubscribe {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  subscribeFromSeq(fromSeq: number | null, listener: SeqEventListener): Unsubscribe {
    if (fromSeq !== null && Number.isFinite(fromSeq)) {
      const ringLow = this.ring[0]?.seq ?? null;
      if (ringLow !== null && fromSeq < ringLow - 1) {
        listener({ type: "session_resync", fromSeq, ringLowSeq: ringLow, lastSeq: this.currentLastSeq } as unknown as PiEvent, this.currentLastSeq);
      }
      for (const entry of this.ring) {
        if (entry.seq > fromSeq) listener(entry.event, entry.seq);
      }
    }
    return this.subscribe(listener);
  }

  get lastSeq(): number {
    return this.currentLastSeq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  clear(): void {
    this.subscribers.clear();
  }

  unsubscribe(): void {
    this.unsubscribeHandle();
    this.unsubscribeHandle = () => undefined;
  }

  close(): void {
    this.clear();
    this.unsubscribe();
  }

  transferSubscribersTo(destination: SessionEventStream): void {
    for (const listener of this.subscribers) destination.subscribers.add(listener);
    this.clear();
  }

  private receive(event: PiEvent, seq: number, ringSize: number, onEvent?: (event: PiEvent) => void): void {
    this.currentLastSeq = seq;
    this.ring.push({ seq, event });
    if (this.ring.length > ringSize) this.ring.shift();
    for (const listener of this.subscribers) {
      try { listener(event, seq); } catch { /* listener errors must not break the bus */ }
    }
    try { onEvent?.(event); } catch { /* observers must not break the bus */ }
  }
}
