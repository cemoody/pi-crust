import fs from "node:fs";
import fsp from "node:fs/promises";
import { toSessionMessages } from "../pi/pirpc-pi-adapter.js";
import type { SessionMessage } from "../pi/types.js";
import { isRecord } from "../../shared/util.js";
import { hydrateTranscriptSidecars } from "../pi/transcript-sidecars.js";

export interface TranscriptTailOptions {
  readonly limit: number;
  readonly before?: number;
}

/**
 * Reads up to `limit` recent SessionMessage entries from the end of a
 * jsonl-formatted session file without loading the whole file. Returns
 * undefined when the file can't be opened (caller should fall back to the
 * adapter). Multi-byte UTF-8 safe: we never decode a chunk until we have a
 * complete line boundary (newline). Large JSONL entries are common (artifact
 * payloads and tool output can be many MiB), so partial-line chunks are kept
 * as a rope and concatenated only once when their newline is reached. Repeated
 * Buffer.concat() while scanning backwards makes a N-MiB record O(N²) copies.
 */
export async function readSessionMessagesTail(
  sessionFile: string,
  options: TranscriptTailOptions,
  beforeMainThreadParse?: () => void,
): Promise<readonly SessionMessage[] | undefined> {
  if (!sessionFile) return undefined;
  let stat: import("node:fs").Stats;
  try { stat = await fsp.stat(sessionFile); } catch { return undefined; }
  if (!stat.isFile()) return undefined;
  // Treat an empty session file as "no on-disk transcript yet" and defer to
  // the adapter, which may still have in-memory messages (e.g. mock adapter
  // and fresh sessions whose first prompt hasn't been persisted).
  if (stat.size === 0) return undefined;

  const TAIL_CHUNK_SIZE = 64 * 1024;
  const fd = await fsp.open(sessionFile, "r");
  try {
    let position = stat.size;
    // Chunks belonging to the beginning of a line that started before the
    // bytes read so far. They are deliberately NOT concatenated on every
    // backwards read: a 6 MiB JSONL line otherwise performs roughly 6 MiB +
    // 5.94 MiB + … of copying before it can even be parsed.
    let partialLineChunks: Buffer[] = [];
    const collected: SessionMessage[] = [];
    // Track whether we saw ANY parseable jsonl record (message OR session
    // header). If a non-empty file produces zero such records the file
    // probably isn't a session jsonl at all (e.g. the mock adapter's
    // pretty-printed .mock-session.json blobs) — fall back to the adapter
    // rather than silently returning an empty timeline.
    let sawSessionShapedRecord = false;

    // Read backwards until we have collected `limit` *normalized* messages
    // (or hit the start of the file). We deliberately do NOT stop at
    // `limit` RAW records: toSessionMessages() merges every
    // `role:"toolResult"` record into its matching tool row and drops
    // empty tool-call-only assistant turns, so a window of N raw records
    // can normalize to fewer than N messages. Stopping at N raw would hand
    // the client a short page (< limit) even though older history exists;
    // SessionDashboard reads `messages.length >= limit` as "a full page,
    // so more probably exist" and would otherwise disable scroll-up
    // pagination for the rest of the transcript. Regression observed on
    // tool-heavy sessions that only ever rendered their tail; pinned by
    // tests/e2e/http-api-tail-read-pagination-shrink.test.ts.
    while (position > 0) {
      const readSize = Math.min(TAIL_CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.allocUnsafe(readSize);
      await fd.read(chunk, 0, readSize, position);

      // The current chunk precedes all accumulated partial chunks. Find its
      // first newline before concatenating anything. If no newline exists the
      // chunk is just another fragment of one giant JSONL entry, so adding a
      // Buffer view to the rope is O(1).
      const firstNewline = position > 0 ? chunk.indexOf(0x0a) : -1;
      if (position > 0 && firstNewline === -1) {
        partialLineChunks.unshift(chunk);
        continue;
      }

      // Everything after the first newline is complete JSONL data (including
      // the partial suffix that came from later reads). Join it once now that
      // we know a line boundary exists. At EOF position=0 the whole remainder
      // is complete data and follows the same path.
      const completePrefix = position > 0 ? chunk.subarray(firstNewline + 1) : chunk;
      const complete = partialLineChunks.length === 0
        ? completePrefix
        : Buffer.concat([completePrefix, ...partialLineChunks]);
      partialLineChunks = position > 0 ? [chunk.subarray(0, firstNewline)] : [];

      const text = complete.toString("utf8");
      const lines = text.split("\n");
      // We collect the *raw* JSONL message bodies in this pass and run
      // them through toSessionMessages() at the end so the on-disk
      // pirpc / Anthropic-messages shape (assistant turns with
      // `content: [...toolCall blocks]` and free-standing
      // `role: "toolResult"` records) gets fanned out into the same
      // assistant + role:"tool" + role:"summary" sequence the adapter's
      // own getMessages() path produces. Without that fan-out,
      // toDashboardMessages sees `role: "toolResult"`, falls through to
      // "custom" and the pi-crust renders the result body as a free-standing
      // "Extension"-labelled bubble instead of merging the output into
      // the matching tool row. Regression introduced in PR #102 alongside
      // this tail-read path; pinned by
      // tests/playwright/structured-content-tool-calls.spec.ts.
      const fresh: unknown[] = [];
      beforeMainThreadParse?.();
      beforeMainThreadParse = undefined;
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!isRecord(entry)) continue;
        if (entry.type === "session" || entry.type === "message" || entry.type === "session_info" || entry.type === "custom_message") {
          sawSessionShapedRecord = true;
        }
        // The numeric timestamp lives on the outer wrapper as an ISO
        // string; the inner message often doesn't carry its own. Coerce
        // and stamp it onto the message so downstream consumers (the
        // before-filter here, toSessionMessages, the pi-crust ordering) all
        // see a consistent number.
        let innerMessage: Record<string, unknown> | undefined;
        if (entry.type === "message" && isRecord(entry.message)) {
          innerMessage = entry.message as Record<string, unknown>;
        } else if (entry.type === "custom_message" && typeof entry.customType === "string") {
          // `type: "custom_message"` entries -- e.g. the artifact
          // records the @cemoody/pi-artifact `display(...)` tool writes
          // -- store their message body flat on the OUTER record (no
          // nested `.message` field). Strip the wrapper-only fields so
          // toSessionMessages sees the same shape it does for the
          // adapter's in-memory getMessages() path (which DOES emit
          // these via its `role === "custom" || customType.length > 0`
          // branch). Without this branch the tail-read fast path
          // silently drops every artifact custom-message on reload,
          // which means MessageTimeline's ArtifactView has nothing to
          // render and the user sees only the bare `display` tool card.
          const { type: _wrapperType, id: _wrapperId, parentId: _wrapperParent, display: _wrapperDisplay, timestamp: _wrapperTimestamp, ...rest } = entry as Record<string, unknown>;
          innerMessage = { role: "custom", ...rest };
        }
        if (!innerMessage) continue;
        let timestamp: number | undefined;
        if (typeof innerMessage.timestamp === "number") timestamp = innerMessage.timestamp;
        else if (typeof entry.timestamp === "string") {
          const parsed = Date.parse(entry.timestamp);
          if (!Number.isNaN(parsed)) timestamp = parsed;
        } else if (typeof entry.timestamp === "number") timestamp = entry.timestamp;
        if (options.before !== undefined && timestamp !== undefined && timestamp >= options.before) continue;
        fresh.push(timestamp === undefined ? innerMessage : { ...innerMessage, timestamp });
      }
      // unshift in collected-but-still-raw form; we flatten once at the
      // end so toSessionMessages's toolCall/toolResult index works
      // across the whole window, not per-chunk.
      if (fresh.length === 0) continue;
      collected.unshift(...(fresh as SessionMessage[]));
      // Count the way the client (and the final return below) does: after
      // the fan-out. Do this only when a chunk yielded new records. A giant
      // line can span hundreds of 64 KiB reads; normalizing the exact same
      // `collected` array after every empty fragment used to add needless
      // CPU work on top of the repeated buffer copying above.
      if (toSessionMessages(collected).length >= options.limit) break;
    }
    if (!sawSessionShapedRecord) return undefined;
    // Run the full raw-JSONL window through toSessionMessages so the
    // adapter's structured-content fan-out (toolCall blocks -> synthetic
    // role:"tool" entries, toolResult records merged into the matching
    // tool entry, thinking blocks split into the assistant's `thinking`
    // field) applies uniformly. THEN apply the limit, since the fan-out
    // can change the message count (one assistant turn with N toolCall
    // blocks expands to 1 assistant + N tool rows).
    const normalized = toSessionMessages(await hydrateTranscriptSidecars(sessionFile, collected));
    return normalized.slice(-options.limit);
  } finally {
    await fd.close();
  }
}

