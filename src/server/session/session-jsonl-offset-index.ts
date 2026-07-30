import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../../shared/util.js";

/**
 * A durable, rebuildable line index for JSONL transcripts used by the
 * `/messages?limit=` tail pager. The transcript is always the source of truth:
 * an unreadable, stale, or malformed sidecar is rebuilt; a failure to do that
 * lets the caller use its pre-index tail scanner.
 */
const INDEX_VERSION = 1;
const ANCHOR_BYTES = 4096;
const DEFERRED_BUILD_DELAY_MS = 1_000;
const deferredBuilds = new Set<string>();

export interface JsonlTailReadMetrics {
  sourceBytesRead: number;
  sourceRecordsParsed: number;
}

export interface JsonlTailReadOptions<T> {
  readonly limit: number;
  readonly before?: number;
  readonly normalize: (raw: readonly unknown[]) => readonly T[];
  /** Test-only observability; counts bytes read from the JSONL, never sidecars. */
  readonly metrics?: JsonlTailReadMetrics;
  /** Test seam: build synchronously. Production deliberately defers cold builds. */
  readonly eagerBuild?: boolean;
}

interface IndexedRecord {
  readonly offset: number;
  readonly length: number;
  /** Milliseconds when known. Undefined intentionally matches legacy paging. */
  readonly timestamp?: number;
}

interface SourceFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  /** Hashes make an apparent append safe even when a file was replaced in-place. */
  readonly headAnchor: string;
  readonly endAnchor: string;
}

interface JsonlOffsetIndex {
  readonly version: number;
  readonly source: SourceFingerprint;
  /** The byte immediately after the last complete line indexed. */
  readonly scanOffset: number;
  readonly sawSessionShapedRecord: boolean;
  readonly records: readonly IndexedRecord[];
}

function sidecarPath(sessionFile: string): string {
  return path.join(path.dirname(sessionFile), `.${path.basename(sessionFile)}.pi-crust-message-offsets.v${INDEX_VERSION}.json`);
}

/**
 * Read a tail page through the offset index. `undefined` deliberately means
 * "use the old tail scan / adapter fallback" rather than silently returning a
 * potentially incomplete transcript.
 */
export async function readIndexedJsonlTail<T>(
  sessionFile: string,
  options: JsonlTailReadOptions<T>,
): Promise<readonly T[] | undefined> {
  if (!sessionFile) return undefined;
  let stat: Stats;
  try { stat = await fsp.stat(sessionFile); } catch { return undefined; }
  if (!stat.isFile() || stat.size === 0) return undefined;

  let index = await loadIndex(sidecarPath(sessionFile));
  if (index) index = await reconcileIndex(sessionFile, stat, index, options.metrics);
  // A missing, corrupt, or stale index must never turn a bounded first page
  // into a full transcript scan. The caller uses the established backwards
  // reader now; `deferJsonlOffsetIndexBuild` warms this sidecar after the
  // response path is clear.
  if (!index && options.eagerBuild) index = await rebuildIndex(sessionFile, stat, options.metrics);
  if (!index || !index.sawSessionShapedRecord) return undefined;
  // Persistence is best effort. This branch runs only for an existing index,
  // its bounded append reconciliation, or the explicit test eager-build seam.
  await persistIndex(sidecarPath(sessionFile), index);

  const candidates = index.records.filter((record) =>
    options.before === undefined || record.timestamp === undefined || record.timestamp < options.before,
  );
  const raw: unknown[] = [];
  for (let end = candidates.length; end > 0;) {
    // Read progressively older index entries until fan-out produces a full
    // page. ToolResult entries can merge into tool rows during normalization.
    const start = Math.max(0, end - options.limit);
    const batch = candidates.slice(start, end);
    const parsed = await readIndexedRecords(sessionFile, batch, options.metrics);
    if (parsed === undefined) return undefined;
    raw.unshift(...parsed);
    if (options.normalize(raw).length >= options.limit) break;
    end = start;
  }
  // Do not serve a page assembled across a replacement/append race. The
  // legacy reader will take a fresh snapshot; the next request reconciles the
  // durable sidecar incrementally.
  let finalStat: Stats;
  try { finalStat = await fsp.stat(sessionFile); } catch { return undefined; }
  if (!sameSource(index.source, finalStat)) return undefined;
  return options.normalize(raw).slice(-options.limit);
}

/**
 * Build a missing/stale sidecar after the request has returned. One delayed
 * builder per file avoids duplicate full scans under concurrent cold requests;
 * it intentionally never affects the current request's bounded I/O budget.
 */
export function deferJsonlOffsetIndexBuild(sessionFile: string): void {
  if (!sessionFile || deferredBuilds.has(sessionFile)) return;
  deferredBuilds.add(sessionFile);
  const timer = setTimeout(() => {
    void buildDeferredIndex(sessionFile).finally(() => deferredBuilds.delete(sessionFile));
  }, DEFERRED_BUILD_DELAY_MS);
  timer.unref();
}

async function buildDeferredIndex(sessionFile: string): Promise<void> {
  let stat: Stats;
  try { stat = await fsp.stat(sessionFile); } catch { return; }
  if (!stat.isFile() || stat.size === 0) return;
  const existing = await loadIndex(sidecarPath(sessionFile));
  const index = existing ? await reconcileIndex(sessionFile, stat, existing) : await rebuildIndex(sessionFile, stat);
  if (index?.sawSessionShapedRecord) await persistIndex(sidecarPath(sessionFile), index);
}

async function loadIndex(indexFile: string): Promise<JsonlOffsetIndex | undefined> {
  let content: string;
  try { content = await fsp.readFile(indexFile, "utf8"); } catch { return undefined; }
  try {
    const value: unknown = JSON.parse(content);
    return isIndex(value) ? value : undefined;
  } catch { return undefined; }
}

/** Exact match is cheap. A larger file can only reuse the old index after the
 * old end anchor still matches; anything else is a replacement/truncation and
 * gets a clean rebuild. */
async function reconcileIndex(
  sessionFile: string,
  stat: Stats,
  index: JsonlOffsetIndex,
  metrics?: JsonlTailReadMetrics,
): Promise<JsonlOffsetIndex | undefined> {
  const source = index.source;
  if (sameSource(source, stat)) return index;
  if (stat.size <= source.size || stat.dev !== source.dev || stat.ino !== source.ino) {
    return undefined;
  }

  // mtime/ctime necessarily move during a normal append, so verify immutable
  // bytes from the old source before scanning only its new suffix.
  const oldHead = await hashRange(sessionFile, 0, Math.min(ANCHOR_BYTES, source.size), metrics);
  const oldEnd = await hashRange(sessionFile, Math.max(0, source.size - ANCHOR_BYTES), Math.min(ANCHOR_BYTES, source.size), metrics);
  if (oldHead !== source.headAnchor || oldEnd !== source.endAnchor || index.scanOffset > stat.size) {
    return undefined;
  }
  return extendIndex(sessionFile, stat, index, metrics);
}

async function rebuildIndex(
  sessionFile: string,
  stat: Stats,
  metrics?: JsonlTailReadMetrics,
): Promise<JsonlOffsetIndex | undefined> {
  const scanned = await scanRecords(sessionFile, 0, stat.size, [], false, metrics);
  if (!scanned) return undefined;
  const after = await stableStat(sessionFile, stat);
  if (!after) return undefined;
  const sourceFingerprint = await fingerprint(sessionFile, after, metrics);
  if (!sourceFingerprint) return undefined;
  return {
    version: INDEX_VERSION,
    source: sourceFingerprint,
    scanOffset: scanned.scanOffset,
    sawSessionShapedRecord: scanned.sawSessionShapedRecord,
    records: scanned.records,
  };
}

async function extendIndex(
  sessionFile: string,
  stat: Stats,
  index: JsonlOffsetIndex,
  metrics?: JsonlTailReadMetrics,
): Promise<JsonlOffsetIndex | undefined> {
  const scanned = await scanRecords(sessionFile, index.scanOffset, stat.size, index.records, index.sawSessionShapedRecord, metrics);
  if (!scanned) return undefined;
  const after = await stableStat(sessionFile, stat);
  if (!after) return undefined;
  const sourceFingerprint = await fingerprint(sessionFile, after, metrics);
  if (!sourceFingerprint) return undefined;
  return {
    version: INDEX_VERSION,
    source: sourceFingerprint,
    scanOffset: scanned.scanOffset,
    sawSessionShapedRecord: scanned.sawSessionShapedRecord,
    records: scanned.records,
  };
}

async function scanRecords(
  sessionFile: string,
  start: number,
  end: number,
  existing: readonly IndexedRecord[],
  sawSessionShapedRecord: boolean,
  metrics?: JsonlTailReadMetrics,
): Promise<{ records: readonly IndexedRecord[]; scanOffset: number; sawSessionShapedRecord: boolean } | undefined> {
  const bytes = await readRange(sessionFile, start, end - start, metrics);
  if (!bytes) return undefined;
  const records = [...existing];
  let lineStart = start;
  let cursor = 0;
  let saw = sawSessionShapedRecord;
  while (true) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline < 0) break; // trailing partial line stays for the next append
    const line = bytes.subarray(cursor, newline);
    const parsed = parseIndexedLine(line, metrics);
    if (parsed?.shaped) saw = true;
    if (parsed?.record) records.push({ offset: lineStart, length: newline - cursor + 1, ...(parsed.timestamp === undefined ? {} : { timestamp: parsed.timestamp }) });
    cursor = newline + 1;
    lineStart = start + cursor;
  }
  return { records, scanOffset: lineStart, sawSessionShapedRecord: saw };
}

async function readIndexedRecords(
  sessionFile: string,
  records: readonly IndexedRecord[],
  metrics?: JsonlTailReadMetrics,
): Promise<readonly unknown[] | undefined> {
  const result: unknown[] = [];
  for (const record of records) {
    const bytes = await readRange(sessionFile, record.offset, record.length, metrics);
    if (!bytes || bytes.length !== record.length || bytes[bytes.length - 1] !== 0x0a) return undefined;
    const parsed = parseIndexedLine(bytes.subarray(0, -1), metrics);
    // Validate that the indexed line is still a relevant wrapper. The source
    // fingerprint guards normal paths; this is a final race/replacement guard.
    if (!parsed?.record) return undefined;
    const raw = rawMessage(parsed.entry!);
    if (raw) result.push(raw);
  }
  return result;
}

function parseIndexedLine(line: Buffer, metrics?: JsonlTailReadMetrics): { shaped: boolean; record: boolean; timestamp?: number; entry?: Record<string, unknown> } | undefined {
  if (line.length === 0) return undefined;
  let entry: unknown;
  try {
    metrics && (metrics.sourceRecordsParsed += 1);
    entry = JSON.parse(line.toString("utf8"));
  } catch { return undefined; }
  if (!isRecord(entry)) return undefined;
  const shaped = entry.type === "session" || entry.type === "message" || entry.type === "session_info" || entry.type === "custom_message";
  const record = (entry.type === "message" && isRecord(entry.message)) || (entry.type === "custom_message" && typeof entry.customType === "string");
  const timestamp = record ? entryTimestamp(entry) : undefined;
  return { shaped, record, ...(timestamp === undefined ? {} : { timestamp }), entry };
}

function rawMessage(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.type === "message" && isRecord(entry.message)) {
    const timestamp = entryTimestamp(entry);
    return timestamp === undefined ? entry.message : { ...entry.message, timestamp };
  }
  if (entry.type === "custom_message" && typeof entry.customType === "string") {
    const { type: _type, id: _id, parentId: _parentId, display: _display, timestamp: _timestamp, ...rest } = entry;
    const timestamp = entryTimestamp(entry);
    return { role: "custom", ...rest, ...(timestamp === undefined ? {} : { timestamp }) };
  }
  return undefined;
}

function entryTimestamp(entry: Record<string, unknown>): number | undefined {
  if (entry.type === "message" && isRecord(entry.message) && typeof entry.message.timestamp === "number") return entry.message.timestamp;
  if (typeof entry.timestamp === "number") return entry.timestamp;
  if (typeof entry.timestamp === "string") {
    const value = Date.parse(entry.timestamp);
    return Number.isNaN(value) ? undefined : value;
  }
  return undefined;
}

async function fingerprint(sessionFile: string, stat: Stats, metrics?: JsonlTailReadMetrics): Promise<SourceFingerprint | undefined> {
  const headAnchor = await hashRange(sessionFile, 0, Math.min(ANCHOR_BYTES, stat.size), metrics);
  const endAnchor = await hashRange(sessionFile, Math.max(0, stat.size - ANCHOR_BYTES), Math.min(ANCHOR_BYTES, stat.size), metrics);
  if (!headAnchor || !endAnchor) return undefined;
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino, headAnchor, endAnchor };
}

async function hashRange(file: string, offset: number, length: number, metrics?: JsonlTailReadMetrics): Promise<string | undefined> {
  const bytes = await readRange(file, offset, length, metrics);
  return bytes && bytes.length === length ? createHash("sha256").update(bytes).digest("hex") : undefined;
}

async function readRange(file: string, offset: number, length: number, metrics?: JsonlTailReadMetrics): Promise<Buffer | undefined> {
  try {
    const fd = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await fd.read(buffer, 0, length, offset);
      metrics && (metrics.sourceBytesRead += bytesRead);
      return buffer.subarray(0, bytesRead);
    } finally { await fd.close(); }
  } catch { return undefined; }
}

async function stableStat(file: string, before: Stats): Promise<Stats | undefined> {
  try {
    const after = await fsp.stat(file);
    return after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.dev === before.dev && after.ino === before.ino ? after : undefined;
  } catch { return undefined; }
}

function sameSource(source: SourceFingerprint, stat: Stats): boolean {
  return source.size === stat.size && source.mtimeMs === stat.mtimeMs && source.ctimeMs === stat.ctimeMs && source.dev === stat.dev && source.ino === stat.ino;
}

async function persistIndex(indexFile: string, index: JsonlOffsetIndex): Promise<void> {
  const tmp = `${indexFile}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(index), "utf8");
    await fsp.rename(tmp, indexFile);
  } catch {
    try { await fsp.unlink(tmp); } catch { /* best effort */ }
  }
}

function isIndex(value: unknown): value is JsonlOffsetIndex {
  if (!isRecord(value) || value.version !== INDEX_VERSION || !isRecord(value.source) || !Array.isArray(value.records)) return false;
  const source = value.source;
  if (!["size", "mtimeMs", "ctimeMs", "dev", "ino"].every((key) => typeof source[key] === "number") || typeof source.headAnchor !== "string" || typeof source.endAnchor !== "string" || typeof value.scanOffset !== "number" || typeof value.sawSessionShapedRecord !== "boolean") return false;
  const sourceSize = source.size;
  const scanOffset = value.scanOffset;
  if (typeof sourceSize !== "number" || typeof scanOffset !== "number" || !Number.isSafeInteger(sourceSize) || sourceSize < 0 || !Number.isSafeInteger(scanOffset) || scanOffset < 0 || scanOffset > sourceSize) return false;
  let previousEnd = 0;
  for (const record of value.records) {
    if (!isRecord(record)) return false;
    const offset = record.offset;
    const length = record.length;
    if (typeof offset !== "number" || typeof length !== "number" || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset < previousEnd || offset + length > scanOffset || (record.timestamp !== undefined && typeof record.timestamp !== "number")) return false;
    previousEnd = offset + length;
  }
  return true;
}
