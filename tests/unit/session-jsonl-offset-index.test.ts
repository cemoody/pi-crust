import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readSessionMessagesTail, readSessionMessagesTailLegacy } from "../../src/server/http-api-server.js";
import { readIndexedJsonlTail, type JsonlTailReadMetrics } from "../../src/server/session/session-jsonl-offset-index.js";

type Message = { readonly role: string; readonly content: string; readonly timestamp?: number };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });

async function fixture(lines: readonly unknown[]): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-offset-index-"));
  roots.push(root);
  const file = path.join(root, "session.jsonl");
  await fsp.writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

function line(index: number, payload = ""): unknown {
  return { type: "message", timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(), message: { role: "user", content: `message-${index} ${payload}` } };
}
function normalize(raw: readonly unknown[]): readonly Message[] { return raw as Message[]; }
function metrics(): JsonlTailReadMetrics { return { sourceBytesRead: 0, sourceRecordsParsed: 0 }; }
function indexPath(file: string): string { return path.join(path.dirname(file), `.${path.basename(file)}.pi-crust-message-offsets.v1.json`); }

/** Deliberately isolated: no HTTP server or adapter. Giant records make the
 * first indexed rebuild expensive but prove the durable warm path reads/parses
 * only its requested records instead of tail-scanning 64KB blocks. */
describe("durable JSONL message offset index", () => {
  it("defers a cold build so the caller can keep its bounded legacy tail fallback", async () => {
    const file = await fixture([{ type: "session", id: "cold" }, ...Array.from({ length: 50 }, (_, index) => line(index, "x".repeat(32 * 1024)))]);
    const cold = metrics();
    expect(await readIndexedJsonlTail(file, { limit: 2, normalize, metrics: cold })).toBeUndefined();
    expect(cold.sourceBytesRead).toBe(0);
    expect(cold.sourceRecordsParsed).toBe(0);
  });

  it("warm tail page parses and reads dramatically less source than the legacy tail scan", async () => {
    const giant = "x".repeat(256 * 1024);
    // Giant non-message records are realistic session metadata/checkpoint
    // payloads. The old backwards scanner must parse every one to find two
    // messages; the index never puts them in the message-record table.
    const file = await fixture([
      { type: "session", id: "perf" },
      ...Array.from({ length: 96 }, (_, index) => line(index)),
      ...Array.from({ length: 32 }, (_, index) => ({ type: "session_info", checkpoint: index, payload: giant })),
    ]);
    const cold = metrics();
    await readIndexedJsonlTail(file, { limit: 2, normalize, metrics: cold, eagerBuild: true }); // build durable sidecar
    const indexed = metrics();
    const result = await readIndexedJsonlTail(file, { limit: 2, normalize, metrics: indexed });
    const legacy = metrics();
    await legacyTail(file, 2, legacy);

    expect(result?.map((message) => message.content.slice(0, 10))).toEqual(["message-94", "message-95"]);
    // Benchmark result is intentionally source-I/O based, not wall clock: it
    // is deterministic across CI filesystems and directly measures the work
    // avoided by the pager.
    console.info(`offset-index benchmark: warm=${indexed.sourceBytesRead}B/${indexed.sourceRecordsParsed} parses legacy=${legacy.sourceBytesRead}B/${legacy.sourceRecordsParsed} parses`);
    expect(indexed.sourceBytesRead).toBeLessThan(legacy.sourceBytesRead / 20);
    expect(indexed.sourceRecordsParsed).toBeLessThan(legacy.sourceRecordsParsed / 20);
  });

  it("extends safely on append and rebuilds safely on replacement", async () => {
    const file = await fixture([{ type: "session", id: "safe" }, line(1), line(2)]);
    expect((await readIndexedJsonlTail(file, { limit: 2, normalize, eagerBuild: true }))?.map((m) => m.content)).toEqual(["message-1 ", "message-2 "]);
    await fsp.appendFile(file, `${JSON.stringify(line(3))}\n`);
    expect((await readIndexedJsonlTail(file, { limit: 2, normalize }))?.map((m) => m.content)).toEqual(["message-2 ", "message-3 "]);
    const replacement = [{ type: "session", id: "replacement" }, line(100), line(101)];
    const temp = `${file}.replacement`;
    await fsp.writeFile(temp, replacement.map((value) => JSON.stringify(value)).join("\n") + "\n");
    await fsp.rename(temp, file);
    expect((await readIndexedJsonlTail(file, { limit: 2, normalize, eagerBuild: true }))?.map((m) => m.content)).toEqual(["message-100 ", "message-101 "]);
  });

  it("discards corrupt/stale sidecars and preserves the old scanner fallback", async () => {
    const file = await fixture([{ type: "session", id: "bad" }, line(1), line(2)]);
    await fsp.writeFile(indexPath(file), "not json");
    expect((await readIndexedJsonlTail(file, { limit: 1, normalize, eagerBuild: true }))?.[0]?.content).toContain("message-2");
    const stale = JSON.parse(await fsp.readFile(indexPath(file), "utf8"));
    stale.source.endAnchor = "wrong";
    stale.source.size -= 1;
    await fsp.writeFile(indexPath(file), JSON.stringify(stale));
    await fsp.appendFile(file, `${JSON.stringify(line(3))}\n`);
    expect((await readIndexedJsonlTail(file, { limit: 1, normalize, eagerBuild: true }))?.[0]?.content).toContain("message-3");

    const nonJsonl = await fixture([{ unrelated: true }]);
    expect(await readSessionMessagesTail(nonJsonl, { limit: 1 })).toBeUndefined();
    expect(await readSessionMessagesTailLegacy(nonJsonl, { limit: 1 })).toBeUndefined();
  });
});

/** A byte-for-byte behavioral model of the existing backwards chunk scan,
 * instrumented at source read/JSON parse boundaries (no server involved). */
async function legacyTail(file: string, limit: number, out: JsonlTailReadMetrics): Promise<void> {
  const stat = await fsp.stat(file);
  const fd = await fsp.open(file, "r");
  try {
    let position = stat.size;
    let leftover = Buffer.alloc(0);
    let count = 0;
    while (position > 0 && count < limit) {
      const size = Math.min(64 * 1024, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await fd.read(chunk, 0, size, position);
      out.sourceBytesRead += bytesRead;
      const buf = leftover.length ? Buffer.concat([chunk, leftover]) : chunk;
      let start = 0;
      if (position > 0) {
        const newline = buf.indexOf(0x0a);
        if (newline < 0) { leftover = buf; continue; }
        leftover = buf.subarray(0, newline);
        start = newline + 1;
      }
      for (const text of buf.subarray(start).toString("utf8").split("\n")) {
        if (!text) continue;
        out.sourceRecordsParsed++;
        if ((JSON.parse(text) as { type?: string }).type === "message") count++;
      }
    }
  } finally { await fd.close(); }
}
