/**
 * Canonical decomposers for `SessionMessage.content` payloads.
 *
 * Three near-twin implementations had grown across the codebase before
 * this module landed:
 *
 *   - src/server/pi/pirpc-pi-adapter.ts        (most thorough, image-aware)
 *   - src/web/components/session-dashboard-helpers.ts
 *   - src/web/state/pi-event-reducer.ts        (latent bug: JSON-stringified
 *                                                thinking blocks into text)
 *
 * Their semantics had drifted. This module is the single source of truth.
 *
 * Wire shape, on disk and over SSE:
 *
 *   content: string
 *     | undefined
 *     | Array<
 *         | { type: "text",     text: string }
 *         | { type: "thinking", thinking: string }
 *         | { type: "image",    data: string, mimeType?: string }
 *         | { type: "toolCall", ... }    // skipped
 *         | <unknown block>              // skipped
 *       >
 *     | any other value                  // JSON-stringified into text
 *
 * Pinned by tests/unit/shared-wire-content.test.ts.
 */
import { isRecord } from "./util.js";

export interface DecomposedContent {
  readonly text: string;
  readonly thinking: string;
  readonly images: readonly { readonly data: string; readonly mimeType: string }[];
}

export function contentTextAndThinking(content: unknown): DecomposedContent {
  if (typeof content === "string") return { text: content, thinking: "", images: [] };
  if (!Array.isArray(content)) {
    return {
      text: content === undefined ? "" : JSON.stringify(content),
      thinking: "",
      images: [],
    };
  }
  const text: string[] = [];
  const thinking: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    // Order matters for stop-reason-error edge cases: a thinking block
    // with no following text still produces an entry, but the user-visible
    // bubble stays empty (thinking renders in its own collapsed widget).
    if (typeof block.thinking === "string") thinking.push(block.thinking);
    if (typeof block.text === "string") text.push(block.text);
    if (block.type === "image" && typeof block.data === "string") {
      images.push({ data: block.data, mimeType: String(block.mimeType ?? "image/png") });
    }
    // Unknown blocks (toolCall, extension types, etc.) are intentionally
    // skipped — the prior session-dashboard-helpers copy JSON-stringified
    // them into `text`, which leaked tool-call JSON into the assistant
    // bubble. Match the more conservative pirpc-pi-adapter semantics.
  }
  return { text: text.join("\n"), thinking: thinking.join("\n\n"), images };
}

export function contentText(content: unknown): string {
  return contentTextAndThinking(content).text;
}

/**
 * Pull joined `.text` values out of a tool-result envelope:
 *   { content: [{ type: "text", text: "..." }, ...] } -> "...\n..."
 * Returns "" for any other shape.
 */
export function toolResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content.map((item) => isRecord(item) ? String(item.text ?? "") : "").join("\n");
}
