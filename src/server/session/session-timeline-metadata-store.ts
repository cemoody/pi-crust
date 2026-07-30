import path from "node:path";
import fsp from "node:fs/promises";
import { coerceTimestamp, isRecord } from "../../shared/util.js";

export interface SessionTimelineMetadata {
  readonly createdAt: number | null;
  readonly lastUserActivity: number | null;
}

interface CachedSessionTimelineMetadata {
  readonly mtimeMs: number;
  readonly size: number;
  readonly metadata: SessionTimelineMetadata;
}

// Window sizes for head/tail jsonl scans. createdAt sits at the very top of
// the file (the `type: "session"` record); lastUserActivity is approximated
// from the trailing window — sufficient for sidebar sort because sessions
// where the user only typed near the start of a very long transcript would
// have an old lastUserActivity anyway and sort by createdAt.
const TIMELINE_HEAD_SCAN_BYTES = 8 * 1024;
const TIMELINE_TAIL_SCAN_BYTES = 32 * 1024;
const TIMELINE_INDEX_FILENAME = ".pi-timeline-index.json";

/**
 * Bounded, persistent metadata reader for session JSONL files.
 *
 * Sidebar/status requests only need a session's creation time and most recent
 * user activity. This store keeps that responsibility out of the HTTP router,
 * scans only the file head and tail on a cold read, and persists its cache by
 * directory for a fresh API process to reuse.
 */
export class SessionTimelineMetadataStore {
  private readonly cache = new Map<string, CachedSessionTimelineMetadata>();
  private readonly loadedIndexDirs = new Set<string>();
  private readonly loadingIndexes = new Map<string, Promise<void>>();
  private readonly dirtyIndexDirs = new Set<string>();

  async read(sessionFile: string): Promise<SessionTimelineMetadata> {
    if (!sessionFile) return emptyMetadata();
    const dir = path.dirname(sessionFile);
    await this.ensureIndexLoaded(dir);
    try {
      const stat = await fsp.stat(sessionFile);
      const cached = this.cache.get(sessionFile);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.metadata;
      if (cached && stat.size > cached.size) {
        // Incremental update: only read the bytes that have been appended since
        // the last scan. This is the steady-state cost for the active session
        // (the one being typed into) so it dominates the /statuses budget.
        const metadata = await scanTimelineDelta(sessionFile, cached.size, stat.size, cached.metadata);
        this.cache.set(sessionFile, { mtimeMs: stat.mtimeMs, size: stat.size, metadata });
        this.dirtyIndexDirs.add(dir);
        return metadata;
      }
      // Cold (or invalidated) scan: head + tail only, never the whole file.
      const metadata = await scanTimelineHeadAndTail(sessionFile, stat.size);
      this.cache.set(sessionFile, { mtimeMs: stat.mtimeMs, size: stat.size, metadata });
      this.dirtyIndexDirs.add(dir);
      return metadata;
    } catch {
      // Missing/unreadable historical session files degrade to null metadata.
      return emptyMetadata();
    }
  }

  async flush(): Promise<void> {
    if (this.dirtyIndexDirs.size === 0) return;
    const dirs = [...this.dirtyIndexDirs];
    this.dirtyIndexDirs.clear();
    await Promise.all(dirs.map((dir) => this.writeIndex(dir)));
  }

  private async ensureIndexLoaded(dir: string): Promise<void> {
    if (this.loadedIndexDirs.has(dir)) return;
    let pending = this.loadingIndexes.get(dir);
    if (!pending) {
      pending = this.loadIndex(dir).finally(() => {
        this.loadingIndexes.delete(dir);
        this.loadedIndexDirs.add(dir);
      });
      this.loadingIndexes.set(dir, pending);
    }
    await pending;
  }

  private async loadIndex(dir: string): Promise<void> {
    const indexFile = path.join(dir, TIMELINE_INDEX_FILENAME);
    let content: string;
    try { content = await fsp.readFile(indexFile, "utf8"); } catch { return; }
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return; }
    if (!isRecord(parsed)) return;
    const entries = isRecord(parsed.entries) ? parsed.entries : parsed;
    if (!isRecord(entries)) return;
    for (const [basename, value] of Object.entries(entries)) {
      if (!isRecord(value)) continue;
      const mtimeMs = typeof value.mtimeMs === "number" ? value.mtimeMs : null;
      const size = typeof value.size === "number" ? value.size : null;
      if (mtimeMs === null || size === null) continue;
      const createdAt = typeof value.createdAt === "number" ? value.createdAt : null;
      const lastUserActivity = typeof value.lastUserActivity === "number" ? value.lastUserActivity : null;
      const sessionFile = path.join(dir, basename);
      // Only adopt the persisted entry when the in-process cache hasn't already
      // observed a fresher state for that file.
      if (this.cache.has(sessionFile)) continue;
      this.cache.set(sessionFile, { mtimeMs, size, metadata: { createdAt, lastUserActivity } });
    }
  }

  private async writeIndex(dir: string): Promise<void> {
    const entries: Record<string, unknown> = {};
    for (const [sessionFile, cached] of this.cache) {
      if (path.dirname(sessionFile) !== dir) continue;
      entries[path.basename(sessionFile)] = {
        mtimeMs: cached.mtimeMs,
        size: cached.size,
        createdAt: cached.metadata.createdAt,
        lastUserActivity: cached.metadata.lastUserActivity,
      };
    }
    const indexFile = path.join(dir, TIMELINE_INDEX_FILENAME);
    const tmpFile = `${indexFile}.tmp`;
    try {
      await fsp.writeFile(tmpFile, JSON.stringify({ version: 1, entries }), "utf8");
      await fsp.rename(tmpFile, indexFile);
    } catch {
      // Best-effort; a later status poll will retry the persisted snapshot.
      this.dirtyIndexDirs.add(dir);
    }
  }
}

function emptyMetadata(): SessionTimelineMetadata {
  return { createdAt: null, lastUserActivity: null };
}

async function scanTimelineHeadAndTail(sessionFile: string, fileSize: number): Promise<SessionTimelineMetadata> {
  if (fileSize === 0) return emptyMetadata();
  const fd = await fsp.open(sessionFile, "r");
  try {
    let createdAt: number | null = null;
    let lastUserActivity: number | null = null;

    const headSize = Math.min(TIMELINE_HEAD_SCAN_BYTES, fileSize);
    const headBuf = Buffer.alloc(headSize);
    await fd.read(headBuf, 0, headSize, 0);
    const headHasFullFile = headSize === fileSize;
    // If the head window doesn't reach EOF the last line may be partial; drop
    // it so we don't JSON.parse half a record.
    const headText = headBuf.toString("utf8");
    const headSplit = headText.split("\n");
    const headLines = headHasFullFile ? headSplit : headSplit.slice(0, -1);
    for (const line of headLines) {
      const parsed = parseTimelineLine(line);
      if (!parsed) continue;
      if (parsed.createdAt !== undefined && createdAt === null) createdAt = parsed.createdAt;
      if (parsed.userActivity !== undefined) lastUserActivity = Math.max(lastUserActivity ?? 0, parsed.userActivity);
    }

    if (!headHasFullFile) {
      const tailStart = Math.max(headSize, fileSize - TIMELINE_TAIL_SCAN_BYTES);
      const tailSize = fileSize - tailStart;
      const tailBuf = Buffer.alloc(tailSize);
      await fd.read(tailBuf, 0, tailSize, tailStart);
      const tailText = tailBuf.toString("utf8");
      const firstNewline = tailText.indexOf("\n");
      const safeTail = firstNewline >= 0 ? tailText.slice(firstNewline + 1) : tailText;
      for (const line of safeTail.split("\n")) {
        const parsed = parseTimelineLine(line);
        if (parsed?.userActivity !== undefined) lastUserActivity = Math.max(lastUserActivity ?? 0, parsed.userActivity);
      }
    }

    return { createdAt, lastUserActivity };
  } finally {
    await fd.close();
  }
}

async function scanTimelineDelta(sessionFile: string, oldSize: number, newSize: number, previous: SessionTimelineMetadata): Promise<SessionTimelineMetadata> {
  const delta = newSize - oldSize;
  if (delta <= 0) return previous;
  const fd = await fsp.open(sessionFile, "r");
  try {
    const buf = Buffer.alloc(delta);
    await fd.read(buf, 0, delta, oldSize);
    let lastUserActivity = previous.lastUserActivity;
    // The first byte after `oldSize` may be a continuation of a line that was
    // partially flushed before. The common case for our append-only sessions
    // is that we begin exactly at a newline boundary, so the conservative
    // approach is to just skip any incomplete leading line.
    for (const line of buf.toString("utf8").split("\n")) {
      const parsed = parseTimelineLine(line);
      if (parsed?.userActivity !== undefined) lastUserActivity = Math.max(lastUserActivity ?? 0, parsed.userActivity);
    }
    return { createdAt: previous.createdAt, lastUserActivity };
  } finally {
    await fd.close();
  }
}

function parseTimelineLine(line: string): { createdAt?: number | null; userActivity?: number } | undefined {
  if (!line || !line.trim()) return undefined;
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(entry)) return undefined;
  if (entry.type === "session") return { createdAt: coerceTimestamp(entry.timestamp) ?? null };
  if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return undefined;
  const timestamp = coerceTimestamp(entry.message.timestamp) ?? coerceTimestamp(entry.timestamp);
  return timestamp === undefined ? undefined : { userActivity: timestamp };
}
