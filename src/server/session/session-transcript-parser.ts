import { createReadStream } from "node:fs";
import readline from "node:readline";
import { isRecord } from "../../shared/util.js";

const CHUNK_CHARS = 3_500;
const MAX_SESSION_TRANSCRIPT_CHARS = 2_000_000;

export interface ParsedSessionChunk {
  readonly entryId?: string;
  readonly role: "user" | "assistant" | "summary" | "custom";
  readonly timestamp: number | null;
  readonly text: string;
}

/** Search-ready content distilled from one Pi JSONL transcript. */
export interface ParsedSessionTranscript {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number | null;
  readonly lastUserActivity: number | null;
  readonly lastActivity: number | null;
  readonly sessionName?: string;
  readonly subagent: boolean;
  readonly hiddenFromList: boolean;
  readonly firstPrompt: string;
  readonly summaries: string;
  readonly transcript: string;
  readonly chunks: readonly ParsedSessionChunk[];
}

/**
 * Parse the JSONL source of truth into the fields used by the FTS index.
 * Malformed lines and unsupported event types are deliberately ignored so a
 * partially written or forward-compatible transcript remains searchable.
 */
export async function parseSessionTranscript(sessionFile: string): Promise<ParsedSessionTranscript | undefined> {
  let sessionId: string | undefined;
  let cwd = "";
  let createdAt: number | null = null;
  let lastUserActivity: number | null = null;
  let lastActivity: number | null = null;
  let sessionName: string | undefined;
  let subagent = false;
  let hiddenFromList = false;
  let firstPrompt = "";
  const summaries: string[] = [];
  const transcript: string[] = [];
  const chunks: ParsedSessionChunk[] = [];
  let transcriptChars = 0;
  const appendTranscript = (text: string): string => {
    if (transcriptChars >= MAX_SESSION_TRANSCRIPT_CHARS) return "";
    const retained = text.slice(0, MAX_SESSION_TRANSCRIPT_CHARS - transcriptChars);
    transcript.push(retained);
    transcriptChars += retained.length;
    return retained;
  };

  const input = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isRecord(entry)) continue;
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      if (entry.subagent === true) subagent = true;
      if (entry.hiddenFromList === true) hiddenFromList = true;
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
        const retained = appendTranscript(text);
        if (retained) addChunk(chunks, { ...optionalEntryId(entry.id), role: "custom", timestamp: asTimestamp(entry.timestamp), text: retained });
      }
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(message.content);
    const timestamp = asTimestamp(message.timestamp) ?? asTimestamp(entry.timestamp);
    if (timestamp !== null) {
      lastActivity = Math.max(lastActivity ?? 0, timestamp);
      if (role === "user") lastUserActivity = Math.max(lastUserActivity ?? 0, timestamp);
    }
    if (!text) continue;
    if (role === "user" && !firstPrompt) firstPrompt = text.slice(0, 4_000);
    const retained = appendTranscript(text);
    if (retained) addChunk(chunks, { ...optionalEntryId(entry.id), role, timestamp, text: retained });
  }
  if (!sessionId) return undefined;
  return {
    sessionId, cwd, createdAt, lastUserActivity, lastActivity, ...(sessionName ? { sessionName } : {}), subagent, hiddenFromList,
    firstPrompt, summaries: summaries.join("\n\n"), transcript: transcript.join("\n\n"), chunks,
  };
}

function addChunk(target: ParsedSessionChunk[], source: ParsedSessionChunk): void {
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
