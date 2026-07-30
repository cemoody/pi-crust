/**
 * Isolated repro/performance test for transcript-page dedupe. This deliberately
 * never starts HTTP or an existing server: the injected tail reader simulates a
 * costly multi-chunk JSONL scan, so tail-read work is counted exactly rather
 * than inferred from machine-dependent wall clock timings.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionMessage } from "../../src/server/pi/types.js";
import { SessionTranscriptPageCache } from "../../src/server/session-transcript-page-cache.js";

type Version = { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint };

const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map((file) => fsp.rm(file, { recursive: true, force: true })));
});

const page = (label: string): readonly SessionMessage[] => [{ role: "assistant", content: label, timestamp: 1 }];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

describe("SessionTranscriptPageCache", () => {
  it("coalesces 16 concurrent plus repeated identical pages into one deterministic tail read", async () => {
    let tailReads = 0;
    let version: Version = { ino: 7n, size: 100n, mtimeNs: 1n, ctimeNs: 1n };
    const readStarted = deferred<void>();
    const allowReadToFinish = deferred<void>();
    const cache = new SessionTranscriptPageCache(
      async () => {
        tailReads++;
        readStarted.resolve();
        await allowReadToFinish.promise;
        return page("cached page");
      },
      async () => version,
    );
    const query = { sessionId: "s1", sessionFile: "/sessions/s1.jsonl", limit: 200 };

    // All callers arrive while the first multi-chunk tail scan is in flight.
    const concurrent = Array.from({ length: 16 }, () => cache.get(query));
    await readStarted.promise;
    expect(tailReads).toBe(1);
    allowReadToFinish.resolve();
    await expect(Promise.all(concurrent)).resolves.toEqual(Array.from({ length: 16 }, () => page("cached page")));

    // Repeated reads are LRU hits. 32 otherwise-identical requests would have
    // performed 32 tail scans; this does exactly one (32x less tail-read work).
    await Promise.all(Array.from({ length: 32 }, () => cache.get(query)));
    expect(tailReads).toBe(1);

    // Keep the mutable fixture explicit: the cache's version check must not
    // rely on time passing or filesystem timestamp granularity.
    version = { ...version, size: 101n, mtimeNs: 2n, ctimeNs: 2n };
    await cache.get(query);
    expect(tailReads).toBe(2);
  });

  it("invalidates changed JSONL pages and never caches a page read during a write", async () => {
    let version: Version = { ino: 7n, size: 100n, mtimeNs: 1n, ctimeNs: 1n };
    let tailReads = 0;
    const cache = new SessionTranscriptPageCache(
      async () => {
        tailReads++;
        // Model Pi appending while the tail reader has the file open.
        version = { ...version, size: 200n, mtimeNs: 2n, ctimeNs: 2n };
        return page(`read ${tailReads}`);
      },
      async () => version,
    );
    const query = { sessionId: "s1", sessionFile: "/sessions/s1.jsonl", limit: 100, before: 1234 };

    await expect(cache.get(query)).resolves.toEqual(page("read 1"));
    // The first result was returned correctly, but was deliberately not saved
    // because the source changed while it was read.
    await expect(cache.get(query)).resolves.toEqual(page("read 2"));
    expect(tailReads).toBe(2);
  });

  it("invalidates from the real filesystem fingerprint after JSONL append and rewrite", async () => {
    const sessionFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "pi-page-cache-")), "s1.jsonl");
    tempFiles.push(path.dirname(sessionFile));
    await fsp.writeFile(sessionFile, "first\n", "utf8");
    let reads = 0;
    const cache = new SessionTranscriptPageCache(async (file) => {
      reads++;
      return page(await fsp.readFile(file, "utf8"));
    });
    const query = { sessionId: "s1", sessionFile, limit: 50 };

    await expect(cache.get(query)).resolves.toEqual(page("first\n"));
    await expect(cache.get(query)).resolves.toEqual(page("first\n"));
    expect(reads).toBe(1);

    await fsp.appendFile(sessionFile, "grown\n", "utf8");
    await expect(cache.get(query)).resolves.toEqual(page("first\ngrown\n"));
    await fsp.writeFile(sessionFile, "rewritten\n", "utf8");
    await expect(cache.get(query)).resolves.toEqual(page("rewritten\n"));
    expect(reads).toBe(3);
  });

  it("keeps cursor pages distinct and evicts the least recently used page", async () => {
    let reads = 0;
    const cache = new SessionTranscriptPageCache(
      async (_file, options) => {
        reads++;
        return page(`${options.before ?? "tail"}`);
      },
      async () => ({ ino: 1n, size: 1n, mtimeNs: 1n, ctimeNs: 1n }),
      2,
    );
    const base = { sessionId: "s1", sessionFile: "/sessions/s1.jsonl", limit: 50 };
    await cache.get(base);
    await cache.get({ ...base, before: 200 });
    await cache.get(base); // refresh tail page, making before=200 the LRU
    await cache.get({ ...base, before: 100 });
    await cache.get({ ...base, before: 200 });
    expect(reads).toBe(4);
  });
});
