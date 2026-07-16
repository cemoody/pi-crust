import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Local, rebuildable FTS5 index over Pi JSONL session transcripts.
 *
 * Session JSONL remains the source of truth. This database only stores derived
 * search data and is safe to delete; the next sync recreates it from disk.
 */
export interface SessionSearchServiceOptions {
  readonly sessionRoot: string;
  readonly databasePath: string;
  readonly titleWeight?: number;
}

export interface SessionSearchFilters {
  readonly cwd?: string;
  readonly limit?: number;
}

export interface SessionSearchMatch {
  readonly entryId?: string;
  readonly role: "user" | "assistant" | "summary" | "custom";
  readonly timestamp: number | null;
  readonly snippet: string;
}

export interface SessionSearchResult {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sessionName?: string;
  readonly cwd: string;
  readonly createdAt: number | null;
  readonly lastActivity: number | null;
  readonly score: number;
  readonly matches: readonly SessionSearchMatch[];
}

interface ParsedChunk {
  readonly entryId?: string;
  readonly role: SessionSearchMatch["role"];
  readonly timestamp: number | null;
  readonly text: string;
}

interface ParsedSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number | null;
  readonly lastActivity: number | null;
  readonly sessionName?: string;
  readonly firstPrompt: string;
  readonly summaries: string;
  readonly transcript: string;
  readonly chunks: readonly ParsedChunk[];
}

interface FileIndexRow {
  readonly session_file: string;
  readonly mtime_ms: number;
  readonly size: number;
}

interface SearchRow {
  readonly id: number;
  readonly session_id: string;
  readonly session_file: string;
  readonly session_name: string | null;
  readonly cwd: string;
  readonly created_at: number | null;
  readonly last_activity: number | null;
  readonly score: number;
}

interface ChunkRow {
  readonly entry_id: string | null;
  readonly role: SessionSearchMatch["role"];
  readonly timestamp: number | null;
  readonly snippet: string;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const CHUNK_CHARS = 3_500;
const MAX_SESSION_TRANSCRIPT_CHARS = 2_000_000;

export class SessionSearchService {
  private readonly db: DatabaseSync;
  private readonly sessionRoot: string;
  private readonly titleWeight: number;
  private syncing: Promise<void> | undefined;
  private readonly deferredFiles = new Set<string>();
  private syncTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SessionSearchServiceOptions) {
    this.sessionRoot = path.resolve(options.sessionRoot);
    this.titleWeight = options.titleWeight ?? 4;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_documents (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        session_file TEXT NOT NULL UNIQUE,
        cwd TEXT NOT NULL,
        session_name TEXT,
        created_at INTEGER,
        last_activity INTEGER,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        title, first_prompt, summaries, transcript,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS session_chunks (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES session_documents(id) ON DELETE CASCADE,
        entry_id TEXT,
        role TEXT NOT NULL,
        timestamp INTEGER,
        chunk_index INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, tokenize = 'porter unicode61');
      CREATE INDEX IF NOT EXISTS session_documents_file_index ON session_documents(session_file);
      CREATE INDEX IF NOT EXISTS session_chunks_document_index ON session_chunks(document_id, chunk_index);
    `);
  }

  close(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.db.close();
  }

  /**
   * Do not read an actively streaming transcript. Pi writes session JSONL as
   * events arrive, so indexing it during a message_update could preserve a
   * partial assistant reply. The host calls markSessionSettled only after the
   * agent's return has completed, then queues the incremental update.
   */
  markSessionActive(sessionFile: string): void {
    this.deferredFiles.add(path.resolve(sessionFile));
  }

  markSessionSettled(sessionFile: string): void {
    this.deferredFiles.delete(path.resolve(sessionFile));
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.sync().catch((error: unknown) => {
        console.warn(`[session-search] incremental sync failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 250);
    this.syncTimer.unref?.();
  }

  /** Incrementally reconcile the FTS database against the append-only JSONL source. */
  async sync(): Promise<void> {
    if (!this.syncing) this.syncing = this.syncImpl().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  async search(query: string, filters: SessionSearchFilters = {}): Promise<readonly SessionSearchResult[]> {
    const matchQuery = toFtsQuery(query);
    if (!matchQuery) return [];
    await this.sync();
    const limit = clampLimit(filters.limit);
    const where = filters.cwd ? "AND d.cwd = ?" : "";
    const params: (string | number)[] = [matchQuery];
    if (filters.cwd) params.push(filters.cwd);
    params.push(limit);
    // FTS5's bm25() sorts ascending. Put the title first and apply a modest
    // boost so a matching explicit session name normally beats body-only hits.
    const rows = this.db.prepare(`
      SELECT d.id, d.session_id, d.session_file, d.session_name, d.cwd,
             d.created_at, d.last_activity,
             bm25(session_fts, ${this.titleWeight}, 2.0, 1.5, 1.0) AS score
      FROM session_fts
      JOIN session_documents d ON d.id = session_fts.rowid
      WHERE session_fts MATCH ? ${where}
      ORDER BY score ASC, d.last_activity DESC
      LIMIT ?
    `).all(...params) as unknown as SearchRow[];

    return rows.map((row) => ({
      sessionId: row.session_id,
      sessionFile: row.session_file,
      ...(row.session_name ? { sessionName: row.session_name } : {}),
      cwd: row.cwd,
      createdAt: row.created_at,
      lastActivity: row.last_activity,
      score: row.score,
      matches: this.findMatches(row.id, matchQuery),
    }));
  }

  private findMatches(documentId: number, matchQuery: string): readonly SessionSearchMatch[] {
    const rows = this.db.prepare(`
      SELECT c.entry_id, c.role, c.timestamp,
             snippet(chunk_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet
      FROM chunk_fts
      JOIN session_chunks c ON c.id = chunk_fts.rowid
      WHERE chunk_fts MATCH ? AND c.document_id = ?
      ORDER BY bm25(chunk_fts) ASC, c.chunk_index ASC
      LIMIT 2
    `).all(matchQuery, documentId) as unknown as ChunkRow[];
    return rows.map((row) => ({
      ...(row.entry_id ? { entryId: row.entry_id } : {}),
      role: row.role,
      timestamp: row.timestamp,
      snippet: row.snippet,
    }));
  }

  private async syncImpl(): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(this.sessionRoot, { withFileTypes: true }); } catch { return; }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(this.sessionRoot, entry.name));
    const known = new Map<string, FileIndexRow>();
    for (const row of this.db.prepare("SELECT session_file, mtime_ms, size FROM session_documents").all() as unknown as FileIndexRow[]) {
      known.set(row.session_file, row);
    }
    const liveFiles = new Set(files);
    for (const [sessionFile] of known) {
      if (!liveFiles.has(sessionFile)) this.deleteFile(sessionFile);
    }
    for (const sessionFile of files) {
      let stat: import("node:fs").Stats;
      try { stat = await fs.stat(sessionFile); } catch { continue; }
      if (this.deferredFiles.has(sessionFile)) continue;
      const old = known.get(sessionFile);
      if (old && old.mtime_ms === stat.mtimeMs && old.size === stat.size) continue;
      const parsed = await parseSession(sessionFile);
      if (!parsed) {
        // A metadata-only stub is not a transcript and must never linger in
        // search after a source file is replaced with one.
        this.deleteFile(sessionFile);
        continue;
      }
      this.replaceFile(sessionFile, stat, parsed);
    }
  }

  private deleteFile(sessionFile: string): void {
    const row = this.db.prepare("SELECT id FROM session_documents WHERE session_file = ?").get(sessionFile) as { id: number } | undefined;
    if (!row) return;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM session_chunks WHERE document_id = ?)").run(row.id);
      this.db.prepare("DELETE FROM session_chunks WHERE document_id = ?").run(row.id);
      this.db.prepare("DELETE FROM session_fts WHERE rowid = ?").run(row.id);
      this.db.prepare("DELETE FROM session_documents WHERE id = ?").run(row.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceFile(sessionFile: string, stat: import("node:fs").Stats, parsed: ParsedSession): void {
    this.deleteFile(sessionFile);
    this.db.exec("BEGIN");
    try {
      const result = this.db.prepare(`
        INSERT INTO session_documents (session_id, session_file, cwd, session_name, created_at, last_activity, mtime_ms, size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(parsed.sessionId, sessionFile, parsed.cwd, parsed.sessionName ?? null, parsed.createdAt, parsed.lastActivity, stat.mtimeMs, stat.size);
      const documentId = Number(result.lastInsertRowid);
      this.db.prepare("INSERT INTO session_fts(rowid, title, first_prompt, summaries, transcript) VALUES (?, ?, ?, ?, ?)")
        .run(documentId, parsed.sessionName ?? "", parsed.firstPrompt, parsed.summaries, parsed.transcript);
      const insertChunk = this.db.prepare("INSERT INTO session_chunks(document_id, entry_id, role, timestamp, chunk_index) VALUES (?, ?, ?, ?, ?)");
      const insertChunkFts = this.db.prepare("INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)");
      for (const [chunkIndex, chunk] of parsed.chunks.entries()) {
        const result = insertChunk.run(documentId, chunk.entryId ?? null, chunk.role, chunk.timestamp, chunkIndex);
        insertChunkFts.run(Number(result.lastInsertRowid), chunk.text);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

async function parseSession(sessionFile: string): Promise<ParsedSession | undefined> {
  let sessionId: string | undefined;
  let cwd = "";
  let createdAt: number | null = null;
  let lastActivity: number | null = null;
  let sessionName: string | undefined;
  let firstPrompt = "";
  const summaries: string[] = [];
  const transcript: string[] = [];
  const chunks: ParsedChunk[] = [];
  let transcriptChars = 0;

  const input = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isRecord(entry)) continue;
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      createdAt = asTimestamp(entry.timestamp) ?? createdAt;
      continue;
    }
    if (entry.type === "session_info") {
      if (typeof entry.name === "string") sessionName = entry.name.trim() || undefined;
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (typeof entry.summary === "string" && entry.summary.trim()) {
        summaries.push(entry.summary);
        addChunk(chunks, { ...optionalEntryId(entry.id), role: "summary", timestamp: asTimestamp(entry.timestamp), text: entry.summary });
      }
      continue;
    }
    if (entry.type === "custom_message") {
      const text = contentText(entry.content);
      if (text) {
        transcript.push(text);
        transcriptChars += text.length;
        addChunk(chunks, { ...optionalEntryId(entry.id), role: "custom", timestamp: asTimestamp(entry.timestamp), text });
      }
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(message.content);
    const timestamp = asTimestamp(message.timestamp) ?? asTimestamp(entry.timestamp);
    if (timestamp !== null) lastActivity = Math.max(lastActivity ?? 0, timestamp);
    if (!text) continue;
    if (role === "user" && !firstPrompt) firstPrompt = text.slice(0, 4_000);
    if (transcriptChars < MAX_SESSION_TRANSCRIPT_CHARS) {
      const retained = text.slice(0, MAX_SESSION_TRANSCRIPT_CHARS - transcriptChars);
      transcript.push(retained);
      transcriptChars += retained.length;
    }
    addChunk(chunks, { ...optionalEntryId(entry.id), role, timestamp, text });
  }
  if (!sessionId) return undefined;
  return {
    sessionId, cwd, createdAt, lastActivity, ...(sessionName ? { sessionName } : {}),
    firstPrompt, summaries: summaries.join("\n\n"), transcript: transcript.join("\n\n"), chunks,
  };
}

function addChunk(target: ParsedChunk[], source: ParsedChunk): void {
  const text = source.text.trim();
  if (!text) return;
  for (let offset = 0; offset < text.length; offset += CHUNK_CHARS) {
    target.push({ ...source, text: text.slice(offset, offset + CHUNK_CHARS) });
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => typeof block.text === "string" ? block.text : "")
    .join("\n");
}

function asTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function optionalEntryId(value: unknown): { entryId?: string } {
  return typeof value === "string" && value ? { entryId: value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value!)));
}

/** Escape ordinary user text into an AND query. We deliberately do not expose
 * raw FTS query syntax through the public API yet; it avoids malformed query
 * errors and makes literal identifiers / pasted errors predictable. */
function toFtsQuery(query: string): string | undefined {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 16);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}
