/**
 * Fast lister for `.jsonl` session files: head+tail scan that reads only
 * the first 16 KB and last 32 KB of each file. Designed to populate the
 * sidebar (which needs id, cwd, sessionName, firstMessage, createdAt,
 * lastActivity) without parsing multi-megabyte transcripts in full.
 *
 * Extracted from pirpc-pi-adapter.ts so the adapter file can stay focused
 * on the RPC/process lifecycle. Pinned by tests/e2e/pirpc-fast-list-sessions.test.ts
 * and tests/unit/session-jsonl-scanner.test.ts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionListItem } from "./types.js";
import { coerceTimestamp, isRecord, optional } from "../../shared/util.js";

// ---------------------------------------------------------------------------
// Fast session lister: head+tail scan, no full-file parse.
// ---------------------------------------------------------------------------

/** Bytes we read from the start of each session jsonl. Holds the
 * `type:"session"` header plus the first few messages (firstMessage) and
 * an initial `session_info` rename. */
const FAST_LIST_HEAD_BYTES = 16 * 1024;
/** Bytes we read from the end of each session jsonl. Holds the most recent
 * `session_info` and a timestamp for lastActivity. */
const FAST_LIST_TAIL_BYTES = 32 * 1024;
/** Cap on parallel file-handle open()s while scanning the sessions dir. */
const FAST_LIST_CONCURRENCY = 32;

interface ScannedSession {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly sessionName?: string;
  readonly firstMessage?: string;
  readonly createdAt: number | null;
  readonly lastActivity: number;
}

export async function fastListSessions(sessionDir: string | undefined, _cwdFilter?: string): Promise<readonly SessionListItem[]> {
  if (!sessionDir) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionDir, entry.name));

  // NOTE: We intentionally ignore _cwdFilter here. The historical contract of
  // SessionManager.list(cwd, sessionDir) in the pi SDK is: when sessionDir is
  // provided (which pirpc-pi-adapter always does), the cwd argument is only
  // used to derive a *default* sessionDir, NOT to filter the returned
  // sessions. listSessionsFromDir() reads every .jsonl in the dir regardless
  // of header.cwd. A previous version of this function filtered by exact
  // cwd match and made sessions created in child worktrees disappear from
  // the sidebar (#106 revert). The pathPolicy security gate in
  // SessionRegistry.listSessions() still drops sessions whose cwd isn't
  // under an allowed root, which is the only filter the caller actually
  // wants.
  const results: (ScannedSession | null)[] = new Array(candidates.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= candidates.length) return;
      results[index] = await scanSessionFile(candidates[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAST_LIST_CONCURRENCY, candidates.length) }, worker));

  const sessions: SessionListItem[] = [];
  for (const item of results) {
    if (!item) continue;
    sessions.push({
      id: item.id,
      cwd: item.cwd,
      sessionFile: item.sessionFile,
      ...optional({ sessionName: item.sessionName }),
      ...optional({ firstMessage: item.firstMessage }),
      createdAt: item.createdAt,
      lastActivity: item.lastActivity,
    });
  }
  // Match SessionManager.list()'s ordering: most-recently-modified first.
  sessions.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return sessions;
}

async function scanSessionFile(filePath: string): Promise<ScannedSession | null> {
  let stat: import("node:fs").Stats;
  try { stat = await fs.stat(filePath); } catch { return null; }
  if (!stat.isFile() || stat.size === 0) return null;

  const headSize = Math.min(FAST_LIST_HEAD_BYTES, stat.size);
  const tailStart = Math.max(headSize, stat.size - FAST_LIST_TAIL_BYTES);
  const tailSize = stat.size - tailStart;

  let fd: import("node:fs/promises").FileHandle;
  try { fd = await fs.open(filePath, "r"); } catch { return null; }
  try {
    const headBuf = Buffer.alloc(headSize);
    await fd.read(headBuf, 0, headSize, 0);
    let tailText = "";
    if (tailSize > 0 && tailStart > 0) {
      const tailBuf = Buffer.alloc(tailSize);
      await fd.read(tailBuf, 0, tailSize, tailStart);
      tailText = tailBuf.toString("utf8");
      // Drop the (likely partial) first line in the tail window so we don't
      // parse a fragment.
      const firstNewline = tailText.indexOf("\n");
      if (firstNewline >= 0) tailText = tailText.slice(firstNewline + 1);
    }
    const headText = headBuf.toString("utf8");
    // If head and tail overlap (small file) we'll iterate twice; the merge
    // logic below tolerates duplicates.
    return parseScannedSession(filePath, stat, headText, tailText);
  } finally {
    await fd.close();
  }
}

function parseScannedSession(
  filePath: string,
  stat: import("node:fs").Stats,
  headText: string,
  tailText: string,
): ScannedSession | null {
  let id: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | null = null;
  let firstMessage: string | undefined;
  let sessionName: string | undefined;
  let sessionNameSeenAt = -1; // entry index of latest session_info
  let lastActivity = 0;
  let entryIndex = 0;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let entry: unknown;
    try { entry = JSON.parse(trimmed); } catch { return; }
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const i = entryIndex++;
    if (record.type === "session") {
      if (id === undefined && typeof record.id === "string") id = record.id;
      if (cwd === undefined && typeof record.cwd === "string") cwd = record.cwd;
      if (createdAt === null) createdAt = coerceTimestamp(record.timestamp) ?? null;
      const ts = coerceTimestamp(record.timestamp);
      if (ts !== undefined && ts > lastActivity) lastActivity = ts;
      return;
    }
    if (record.type === "session_info") {
      if (i > sessionNameSeenAt) {
        sessionNameSeenAt = i;
        const candidate = typeof record.name === "string" ? record.name.trim() : "";
        sessionName = candidate || undefined;
      }
    }
    if (record.type === "message") {
      const inner = isRecord(record.message) ? record.message : undefined;
      const ts = coerceTimestamp(inner?.timestamp) ?? coerceTimestamp(record.timestamp);
      if (ts !== undefined && ts > lastActivity) lastActivity = ts;
      if (firstMessage === undefined && inner && inner.role === "user") {
        firstMessage = extractFirstMessageText(inner.content);
      }
    }
  };

  for (const line of headText.split("\n")) handleLine(line);
  for (const line of tailText.split("\n")) handleLine(line);

  if (!id) return null;
  const resolvedCwd = cwd ?? "";
  if (lastActivity === 0) lastActivity = stat.mtimeMs;
  return {
    id,
    cwd: resolvedCwd,
    sessionFile: filePath,
    ...optional({ sessionName }),
    ...optional({ firstMessage }),
    createdAt: createdAt ?? null,
    lastActivity,
  };
}

function extractFirstMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.slice(0, 240);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) return text.slice(0, 240);
      }
    }
  }
  return undefined;
}

