/**
 * Value-based properties of the RingBuffer used by pirpc-supervisor.
 *
 * fast-check isn't a project dependency yet, so we drive the same
 * "many random inputs" check with a deterministic seeded RNG. The
 * properties tested here are the same we'd state in a fast-check spec.
 *
 * Note: the RingBuffer class is defined inline in scripts/pirpc-supervisor.mjs
 * and isn't exported. To test it as a unit we either (a) extract it to a
 * helper file or (b) re-implement the contract here. We do (a) in a follow-up
 * commit (src/server/session/ring-buffer.ts) so this test can import directly.
 */

import { describe, expect, it } from "vitest";
import { RingBuffer } from "../../src/server/session/ring-buffer.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("RingBuffer properties", () => {
  it("never exceeds its capacity, for any sequence of pushes", () => {
    const rng = mulberry32(0xDEADBEEF);
    for (let trial = 0; trial < 50; trial++) {
      const cap = 1 + Math.floor(rng() * 200);
      const ops = Math.floor(rng() * 1000);
      const ring = new RingBuffer<{ seq: number }>(cap);
      for (let i = 0; i < ops; i++) ring.push({ seq: i + 1 });
      expect(ring.all().length).toBeLessThanOrEqual(cap);
    }
  });

  it("low water mark is monotonically non-decreasing across pushes", () => {
    const rng = mulberry32(0xFEEDF00D);
    for (let trial = 0; trial < 50; trial++) {
      const cap = 1 + Math.floor(rng() * 100);
      const ring = new RingBuffer<{ seq: number }>(cap);
      let prevLow: number | null = null;
      for (let i = 0; i < 500; i++) {
        ring.push({ seq: i + 1 });
        const low = ring.lowSeq();
        if (prevLow !== null && low !== null) {
          expect(low, `lowSeq must not decrease (trial ${trial}, i=${i})`).toBeGreaterThanOrEqual(prevLow);
        }
        prevLow = low;
      }
    }
  });

  it("since(N) returns only items with seq > N, in seq order", () => {
    const rng = mulberry32(0xCAFEBABE);
    for (let trial = 0; trial < 30; trial++) {
      const cap = 10 + Math.floor(rng() * 50);
      const ring = new RingBuffer<{ seq: number }>(cap);
      const total = cap * 3;
      for (let i = 1; i <= total; i++) ring.push({ seq: i });
      const cutoff = Math.floor(rng() * total);
      const out = ring.since(cutoff);
      for (const item of out) expect(item.seq).toBeGreaterThan(cutoff);
      for (let i = 1; i < out.length; i++) {
        const a = out[i]; const b = out[i - 1];
        if (!a || !b) throw new Error("unreachable");
        expect(a.seq, "since() should preserve order").toBeGreaterThan(b.seq);
      }
    }
  });

  it("after capacity overflow, the oldest items have been evicted", () => {
    const cap = 8;
    const ring = new RingBuffer<{ seq: number; mark: string }>(cap);
    for (let i = 1; i <= cap; i++) ring.push({ seq: i, mark: "early" });
    for (let i = cap + 1; i <= cap * 3; i++) ring.push({ seq: i, mark: "late" });
    const items = ring.all();
    expect(items.length).toBe(cap);
    for (const it of items) expect(it.mark).toBe("late");
    const first = items[0]; const last = items[items.length - 1];
    if (!first || !last) throw new Error("unreachable");
    expect(first.seq).toBe(cap * 2 + 1);
    expect(last.seq).toBe(cap * 3);
  });

  it("lowSeq is null on an empty ring", () => {
    expect(new RingBuffer<{ seq: number }>(10).lowSeq()).toBeNull();
  });
});
