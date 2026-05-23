/**
 * Bounded FIFO used by pirpc-supervisor to retain recent rpc frames for
 * resume-on-reconnect. Extracted from scripts/pirpc-supervisor.mjs so the
 * tests can import it directly (the supervisor used to define it inline).
 *
 * Contract:
 *
 *   - `push(item)` is O(n) in the worst case (Array.shift) but n is the
 *     bounded capacity so this is fine for the small caps (≤ 1024) we use.
 *   - `lowSeq()` returns the smallest seq currently in the ring, or null
 *     when empty. Monotonically non-decreasing across pushes.
 *   - `since(N)` returns items with seq > N in seq order.
 *   - `all()` returns a defensive copy of every item in insertion order.
 *
 * Items must have a numeric `seq` property; the buffer doesn't synthesize
 * one for you.
 */

export interface SeqItem {
  seq: number;
  [k: string]: unknown;
}

export class RingBuffer<T extends SeqItem> {
  public readonly capacity: number;
  private items: T[];

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive number, got ${capacity}`);
    }
    this.capacity = Math.floor(capacity);
    this.items = [];
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  lowSeq(): number | null {
    if (this.items.length === 0) return null;
    const first = this.items[0];
    return first ? first.seq : null;
  }

  since(seq: number): T[] {
    return this.items.filter((it) => it.seq > seq);
  }

  all(): T[] {
    return this.items.slice();
  }

  get length(): number {
    return this.items.length;
  }
}
