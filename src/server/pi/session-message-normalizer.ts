import { isRecord, optional } from "../../shared/util.js";
import { contentTextAndThinking as sharedContentTextAndThinking } from "../../shared/wire-content.js";
import { PAYLOAD_REF_KEY, payloadRefMeta } from "./extensions/payload-budget.js";
import type { SessionMessage } from "./types.js";

/**
 * Converts Pi's persisted RPC/JSONL message records into the timeline's
 * stable SessionMessage model. Keeping this boundary separate from process
 * supervision makes reload and tail-read behavior independently testable.
 */
export function toSessionMessages(messages: readonly unknown[]): SessionMessage[] {
  const result: SessionMessage[] = [];
  const toolCallIndexes = new Map<string, number>();

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = String(message.role ?? "");
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();

    if (role === "compactionSummary") {
      const summary = typeof message.summary === "string" ? message.summary : contentText(message.content);
      if (summary.trim()) {
        result.push({
          role: "summary",
          content: summary,
          timestamp,
          summaryKind: "compaction",
        });
      }
      continue;
    }

    if (role === "branchSummary") {
      const summary = typeof message.summary === "string" ? message.summary : contentText(message.content);
      if (summary.trim()) {
        result.push({
          role: "summary",
          content: summary,
          timestamp,
          summaryKind: "branch",
        });
      }
      continue;
    }

    if (role === "custom" || (typeof message.customType === "string" && message.customType.length > 0)) {
      const customType = String(message.customType ?? "");
      const content = typeof message.content === "string" ? message.content : contentText(message.content);
      const details = isRecord(message.details) ? message.details : undefined;
      result.push({
        role: "custom",
        content,
        timestamp,
        ...(customType ? { customType } : {}),
        ...(details ? { details } : {}),
      });
      continue;
    }

    if (role === "assistant") {
      const { text: rawText, thinking } = contentTextAndThinking(message.content);
      const text = rawText.trim();
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
      // Emit an assistant entry whenever we have visible text OR thinking
      // OR when the turn ended in an error / non-trivial stopReason.
      // Without this the pi-crust sees nothing for failed turns and looks
      // "frozen".
      const trimmedThinking = thinking.trim();
      const shouldEmit = text.length > 0 || trimmedThinking.length > 0 || stopReason === "error" || errorMessage !== undefined;
      if (shouldEmit) {
        result.push({
          role: "assistant",
          content: text,
          timestamp,
          ...(trimmedThinking ? { thinking: trimmedThinking } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        });
      }

      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const id = String(block.id ?? block.toolCallId ?? "");
        if (!id) continue;
        const args = isRecord(block.arguments)
          ? block.arguments
          : isRecord(block.input)
            ? block.input
            : {};
        const index = result.length;
        result.push({
          role: "tool",
          content: "",
          timestamp,
          tool: {
            id,
            name: String(block.name ?? block.toolName ?? ""),
            args,
            status: "running",
            output: "",
            // The assistant turn's timestamp is when the toolCall was
            // emitted — the best proxy for 'tool started' we have at the
            // JSONL reload path. Streaming overlays a more precise
            // Date.now() via the SSE event reducer.
            startedAt: timestamp,
          },
        });
        toolCallIndexes.set(id, index);
      }
      continue;
    }

    if (role === "user" || role === "system") {
      const { text, images } = contentTextAndImages(message.content);
      result.push({
        role: role as "user" | "system",
        content: text,
        timestamp,
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }

    if (role === "toolResult") {
      const { text: output, images } = contentTextAndImages(message.content);
      const outputPayloadRef = Array.isArray(message.content)
        ? message.content.find((block) => isRecord(block) && typeof block.payloadRef === "object" && payloadRefMeta(block.payloadRef))?.payloadRef
        : undefined;
      const toolCallId = String(message.toolCallId ?? message.id ?? "");
      const artifact = extractToolResultArtifact(message.details);
      const index = toolCallIndexes.get(toolCallId);
      if (index !== undefined) {
        const previous = result[index];
        if (previous?.role === "tool" && previous.tool) {
          result[index] = {
            ...previous,
            content: output,
            timestamp,
            tool: {
              ...previous.tool,
              status: message.isError ? "error" : "success",
              output,
              ...optional({ outputPayloadRef }),
              completedAt: timestamp,
              ...optional({ artifact }),
              ...(images.length > 0 ? { images } : {}),
            },
          };
          continue;
        }
      }
      result.push({ role: "tool", content: output, timestamp });
    }
  }

  return result;
}

function contentText(content: unknown): string {
  return sharedContentTextAndThinking(content).text;
}

/**
 * Pull `details.piRemoteControlArtifact` (if present) out of a toolResult
 * message's persisted details. Used so that artifacts attached to tool
 * results (show_presentation, show_artifact, etc.) survive a /messages
 * fetch and re-render correctly after a page reload.
 */
function extractToolResultArtifact(details: unknown): unknown {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { piRemoteControlArtifact?: unknown }).piRemoteControlArtifact;
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? value : undefined;
}

function contentTextAndImages(content: unknown): { text: string; images: NonNullable<SessionMessage["images"]> } {
  // Reuse the canonical extractor and drop thinking on the floor for callers
  // (user / system / toolResult) that don't surface a separate thinking
  // field. Assistant messages go through contentTextAndThinking instead.
  const { text, images } = sharedContentTextAndThinking(content);
  const externalized = Array.isArray(content)
    ? content.flatMap((block) => {
      if (!isRecord(block) || block.type !== "image") return [];
      const meta = payloadRefMeta({ [PAYLOAD_REF_KEY]: block[PAYLOAD_REF_KEY] });
      return meta ? [{ data: "", mimeType: String(block.mimeType ?? "image/png"), payloadRef: { [PAYLOAD_REF_KEY]: meta } }] : [];
    })
    : [];
  return { text, images: [...images, ...externalized] as NonNullable<SessionMessage["images"]> };
}

/**
 * Pirpc-flavoured decomposer that also returns extracted image attachments.
 * Delegates to the canonical helper in shared/wire-content.ts and just
 * widens its readonly `images` type back to the SessionMessage mutable
 * shape the HTTP layer expects.
 *
 * Exported because the /messages HTTP route (toDashboardMessages in
 * http-api-server.ts) needs the same fan-out as the adapter's own
 * getMessages() path: PR #102's tail-read fast path bypasses the adapter
 * entirely, so without this helper a fresh session-load sends array
 * content straight to the pi-crust and the safe-markdown coercion in
 * MessageTimeline stringifies the blocks into the assistant bubble. Pinned
 * by tests/playwright/structured-content-tool-calls.spec.ts.
 */
export function contentTextAndThinking(content: unknown): { text: string; thinking: string; images: NonNullable<SessionMessage["images"]> } {
  const { text, thinking, images } = sharedContentTextAndThinking(content);
  return { text, thinking, images: images as NonNullable<SessionMessage["images"]> };
}
