import fsp from "node:fs/promises";
import type { SessionMessage } from "./pi/types.js";

/** A deliberately small per-server cache: transcript pages are large. */
export const TRANSCRIPT_PAGE_CACHE_CAPACITY = 32;

export interface TranscriptPageQuery {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly limit: number;
  readonly before?: number;
}

interface TranscriptFileVersion {
  readonly size: bigint;
  /** Nanosecond fields avoid a same-millisecond append or rewrite serving stale JSONL. */
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly ino: bigint;
}

interface CachedPage {
  readonly version: TranscriptFileVersion;
  readonly messages: readonly SessionMessage[];
}

export type ReadTranscriptPage = (
  sessionFile: string,
  options: { readonly limit: number; readonly before?: number },
) => Promise<readonly SessionMessage[] | undefined>;

export type StatTranscriptFile = (sessionFile: string) => Promise<TranscriptFileVersion | undefined>;

/**
 * Coalesces and caches JSONL tail pages while keeping the JSONL file as the
 * source of truth. Every lookup stats the file first; a size, timestamp, or
 * inode change invalidates the page before it can be returned. A second stat
 * after the tail-read prevents caching a page from a file that changed while
 * it was being read.
 */
export class SessionTranscriptPageCache {
  private readonly pages = new Map<string, CachedPage>();
  private readonly inFlight = new Map<string, Promise<readonly SessionMessage[] | undefined>>();

  constructor(
    private readonly readPage: ReadTranscriptPage,
    private readonly statFile: StatTranscriptFile = statTranscriptFile,
    private readonly capacity = TRANSCRIPT_PAGE_CACHE_CAPACITY,
  ) {}

  async get(query: TranscriptPageQuery): Promise<readonly SessionMessage[] | undefined> {
    const version = await this.statFile(query.sessionFile);
    if (!version) return this.readPage(query.sessionFile, pageOptions(query));

    const pageKey = cacheKey(query);
    const cached = this.pages.get(pageKey);
    if (cached && sameVersion(cached.version, version)) {
      // Map insertion order is our LRU order: refresh on every hit.
      this.pages.delete(pageKey);
      this.pages.set(pageKey, cached);
      return cached.messages;
    }
    if (cached) this.pages.delete(pageKey);

    // A new file version must never join an old in-flight read. Including the
    // fingerprint also lets concurrent identical reads share exactly one tail
    // scan, including the expensive multi-chunk scans for older cursor pages.
    const inFlightKey = `${pageKey}\u0000${versionKey(version)}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;

    const task = this.readAndMaybeCache(query, version, pageKey);
    this.inFlight.set(inFlightKey, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(inFlightKey) === task) this.inFlight.delete(inFlightKey);
    }
  }

  clear(): void {
    this.pages.clear();
    this.inFlight.clear();
  }

  private async readAndMaybeCache(
    query: TranscriptPageQuery,
    initialVersion: TranscriptFileVersion,
    pageKey: string,
  ): Promise<readonly SessionMessage[] | undefined> {
    const messages = await this.readPage(query.sessionFile, pageOptions(query));
    // Do not cache adapter-fallback sentinels, and do not retain a possibly
    // stale page when Pi appended to or rewrote the transcript during a read.
    const finalVersion = await this.statFile(query.sessionFile);
    if (!messages || !finalVersion || !sameVersion(initialVersion, finalVersion)) return messages;

    this.pages.set(pageKey, { version: finalVersion, messages });
    while (this.pages.size > Math.max(1, this.capacity)) {
      const oldest = this.pages.keys().next().value;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
    }
    return messages;
  }
}

function pageOptions(query: TranscriptPageQuery): { readonly limit: number; readonly before?: number } {
  return query.before === undefined ? { limit: query.limit } : { limit: query.limit, before: query.before };
}

function cacheKey(query: TranscriptPageQuery): string {
  // The file path prevents an alias/recreated session with the same id from
  // ever inheriting another transcript's cached page.
  return `${query.sessionId}\u0000${query.sessionFile}\u0000${query.limit}\u0000${query.before ?? ""}`;
}

function versionKey(version: TranscriptFileVersion): string {
  return `${version.ino}\u0000${version.size}\u0000${version.mtimeNs}\u0000${version.ctimeNs}`;
}

function sameVersion(a: TranscriptFileVersion, b: TranscriptFileVersion): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function statTranscriptFile(sessionFile: string): Promise<TranscriptFileVersion | undefined> {
  try {
    const stat = await fsp.stat(sessionFile, { bigint: true });
    if (!stat.isFile()) return undefined;
    return { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, ino: stat.ino };
  } catch {
    return undefined;
  }
}
