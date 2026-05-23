/**
 * Static parity check: the inline RingBuffer in scripts/pirpc-supervisor.mjs
 * MUST behave identically to the canonical one in
 * src/server/session/ring-buffer.ts.
 *
 * Why an inline copy at all? The supervisor runs as plain `.mjs` under
 * `node`, no TS loader, no build step. Importing the TS module at
 * supervisor startup would mean either shipping a build artifact or
 * adding a runtime TS loader \u2014 both worse than the parallel-impl
 * tradeoff. So we accept the duplication and pay for it with this test,
 * which extracts both implementations, runs the same workload through
 * them, and asserts the output is identical.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { RingBuffer as CanonicalRingBuffer } from "../../src/server/session/ring-buffer.js";

const supervisorScript = path.resolve(__dirname, "..", "..", "scripts", "pirpc-supervisor.mjs");

async function loadInlineRingBuffer(): Promise<new (cap: number) => {
  push(it: { seq: number; tag: string }): void;
  lowSeq(): number | null;
  since(n: number): Array<{ seq: number; tag: string }>;
  all(): Array<{ seq: number; tag: string }>;
}> {
  const text = await fs.readFile(supervisorScript, "utf8");
  // Extract the `class RingBuffer { ... }` block. Greedy on the matching
  // braces \u2014 the class body is small and self-contained.
  const m = text.match(/class RingBuffer \{[\s\S]*?\n\}/);
  if (!m) throw new Error("could not locate inline RingBuffer in pirpc-supervisor.mjs");
  // Evaluate the class body in an isolated scope. We use a Function
  // factory rather than eval so the closure is clean.
  // eslint-disable-next-line no-new-func
  const ctor = new Function(`${m[0]}\nreturn RingBuffer;`)();
  return ctor;
}

describe("static: RingBuffer parity", () => {
  it("inline (supervisor) and canonical (TS) RingBuffers produce identical traces", async () => {
    const Inline = await loadInlineRingBuffer();
    const cap = 16;
    const inline = new Inline(cap);
    const canonical = new CanonicalRingBuffer<{ seq: number; tag: string }>(cap);

    // Same workload: 100 pushes, then snapshot all + lowSeq + since(k) for
    // various k.
    const trace: string[] = [];
    for (let i = 1; i <= 100; i++) {
      const item = { seq: i, tag: `t${i}` };
      inline.push(item);
      canonical.push({ ...item });
      if (i % 13 === 0) {
        const a = JSON.stringify(inline.all());
        const b = JSON.stringify(canonical.all());
        const aLow = inline.lowSeq();
        const bLow = canonical.lowSeq();
        trace.push(`@${i} a=${a} b=${b} aLow=${aLow} bLow=${bLow}`);
        expect(a, `all() at i=${i}`).toBe(b);
        expect(aLow, `lowSeq at i=${i}`).toBe(bLow);
        for (const k of [-1, 0, 5, 50, 99, 100]) {
          expect(JSON.stringify(inline.since(k)), `since(${k}) at i=${i}`)
            .toBe(JSON.stringify(canonical.since(k)));
        }
      }
    }
    expect(trace.length).toBeGreaterThan(0);
  });
});
