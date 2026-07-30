import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Durable transcript payload budget. This runs inside the Pi worker, before
 * SessionManager appends message_end records to JSONL. The HTTP timeline's
 * transport budget is intentionally separate: it protects responses, while
 * this protects the on-disk source of truth from ever gaining a giant line.
 */
export const MAX_JSONL_MESSAGE_BYTES = 256 * 1024;
export const MAX_INLINE_BINARY_BYTES = 32 * 1024;
export const MAX_INLINE_TOOL_ARGUMENT_BYTES = 64 * 1024;
export const MAX_INLINE_DETAILS_BYTES = 64 * 1024;
export const MAX_INLINE_TOOL_RESULT_TEXT_BYTES = 16 * 1024;
export const PAYLOAD_REF_KEY = "__piCrustPayloadRef";

export interface PayloadRef {
  readonly [PAYLOAD_REF_KEY]: {
    readonly version: 1;
    readonly file: string;
    readonly bytes: number;
    readonly encoding: "utf8" | "base64" | "json";
    readonly reason: "image" | "tool-arguments" | "details" | "message";
  };
}

export interface PayloadBudgetContext {
  readonly cwd: string;
  readonly sessionId: string;
}

export interface PayloadBudgetResult {
  readonly message: Record<string, unknown>;
  readonly externalized: readonly { readonly reason: string; readonly bytes: number }[];
}

export function isPayloadRef(value: unknown): value is PayloadRef {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>)[PAYLOAD_REF_KEY]
    && typeof (value as Record<string, unknown>)[PAYLOAD_REF_KEY] === "object");
}

export function payloadRefMeta(value: unknown): PayloadRef[typeof PAYLOAD_REF_KEY] | undefined {
  if (!isPayloadRef(value)) return undefined;
  const meta = value[PAYLOAD_REF_KEY];
  return typeof meta.file === "string" && typeof meta.bytes === "number" && typeof meta.encoding === "string" ? meta : undefined;
}

export function payloadDirectory(context: PayloadBudgetContext): string {
  return path.resolve(context.cwd, ".pi", "payloads", context.sessionId);
}

async function externalize(
  context: PayloadBudgetContext,
  value: string | Record<string, unknown> | readonly unknown[],
  encoding: "utf8" | "base64" | "json",
  reason: PayloadRef[typeof PAYLOAD_REF_KEY]["reason"],
): Promise<PayloadRef> {
  const body = encoding === "json" ? JSON.stringify(value) : value as string;
  const bytes = Buffer.byteLength(body, "utf8");
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const extension = encoding === "base64" ? "b64" : encoding === "json" ? "json" : "txt";
  const file = `${hash}.${extension}`;
  const dir = payloadDirectory(context);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Content addressing makes retries/idempotent message_end handling safe;
  // never append, because a repeated message_end must not duplicate the blob.
  try {
    await fs.writeFile(path.join(dir, file), body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { [PAYLOAD_REF_KEY]: { version: 1, file, bytes, encoding, reason } };
}

function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

function textPreview(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Slice by code units then trim until it is a valid byte budget. This is
  // deliberately conservative for non-ASCII text.
  let preview = text.slice(0, maxBytes);
  while (Buffer.byteLength(preview, "utf8") > maxBytes) preview = preview.slice(0, -1);
  return `${preview}\n\n…[payload externalized; open details to load ${Buffer.byteLength(text, "utf8")} bytes]…`;
}

/** Convert a finalized Pi message into a bounded JSONL-safe equivalent. */
export async function enforceMessagePayloadBudget(message: Record<string, unknown>, context: PayloadBudgetContext): Promise<PayloadBudgetResult> {
  const next = structuredClone(message);
  const externalized: Array<{ reason: string; bytes: number }> = [];
  const note = (reason: string, bytes: number) => externalized.push({ reason, bytes });
  const content = Array.isArray(next.content) ? next.content : undefined;

  if (content) {
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const record = block as Record<string, unknown>;
      if (record.type === "image" && typeof record.data === "string") {
        const bytes = Buffer.byteLength(record.data, "utf8");
        if (bytes > MAX_INLINE_BINARY_BYTES) {
          const ref = await externalize(context, record.data, "base64", "image");
          content[index] = { type: "image", mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png", [PAYLOAD_REF_KEY]: ref[PAYLOAD_REF_KEY] };
          note("image", bytes);
        }
      }
      if (record.type === "toolCall" && byteLength(record.arguments) > MAX_INLINE_TOOL_ARGUMENT_BYTES) {
        const bytes = byteLength(record.arguments);
        const ref = await externalize(context, (record.arguments ?? {}) as Record<string, unknown>, "json", "tool-arguments");
        record.arguments = ref;
        note("tool-arguments", bytes);
      }
      if (record.type === "text" && typeof record.text === "string" && Buffer.byteLength(record.text, "utf8") > MAX_INLINE_TOOL_RESULT_TEXT_BYTES) {
        const bytes = Buffer.byteLength(record.text, "utf8");
        const ref = await externalize(context, record.text, "utf8", "message");
        record.text = textPreview(record.text, MAX_INLINE_TOOL_RESULT_TEXT_BYTES);
        record.payloadRef = ref;
        note("message", bytes);
      }
    }
  }

  if (next.role === "toolResult" && byteLength(next.details) > MAX_INLINE_DETAILS_BYTES) {
    const details = (next.details && typeof next.details === "object" && !Array.isArray(next.details)) ? next.details as Record<string, unknown> : {};
    const bytes = byteLength(details);
    const ref = await externalize(context, details, "json", "details");
    const artifact = details.piRemoteControlArtifact;
    // Keep enough metadata for the existing lazy artifact card, but no body.
    if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
      const source = artifact as Record<string, unknown>;
      next.details = {
        piRemoteControlArtifact: {
          ...(typeof source.kind === "string" ? { kind: source.kind } : {}),
          ...(typeof source.title === "string" ? { title: source.title.slice(0, 256) } : {}),
          payloadRef: ref,
        },
      };
    } else next.details = { payloadRef: ref, detailsExternalized: true };
    note("details", bytes);
  }

  if (next.role === "custom" && byteLength(next.details) > MAX_INLINE_DETAILS_BYTES) {
    const details = (next.details && typeof next.details === "object" && !Array.isArray(next.details)) ? next.details as Record<string, unknown> : {};
    const bytes = byteLength(details);
    const ref = await externalize(context, details, "json", "details");
    // Preserve URL/path-backed artifacts exactly. For an inline huge artifact,
    // preserve its card metadata and make the omission explicit instead of
    // silently losing the entire custom message on timeline reload.
    const preview: Record<string, unknown> = { payloadRef: ref, detailsExternalized: true };
    for (const key of ["artifactGroupId", "caption", "version"] as const) {
      const value = details[key];
      if (typeof value === "string" || typeof value === "number") preview[key] = value;
    }
    if (Array.isArray(details.artifacts)) {
      preview.artifacts = details.artifacts.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return { externalized: true };
        const artifact = item as Record<string, unknown>;
        const compact: Record<string, unknown> = { externalized: true };
        for (const key of ["mime", "alt", "title"] as const) if (typeof artifact[key] === "string") compact[key] = artifact[key];
        if (artifact.src && typeof artifact.src === "object" && !Array.isArray(artifact.src)) {
          const src = artifact.src as Record<string, unknown>;
          if (src.kind === "url" && typeof src.url === "string") compact.src = { kind: "url", url: src.url };
        }
        return compact;
      });
    }
    next.details = preview;
    note("details", bytes);
  }

  // A pathological extension can still supply a huge primitive/unknown field.
  // Retain an actionable preview rather than allowing one JSONL record to make
  // tail reads, JSON.parse, and browser bootstrap pathological.
  if (byteLength(next) > MAX_JSONL_MESSAGE_BYTES) {
    const bytes = byteLength(next);
    const ref = await externalize(context, next, "json", "message");
    const role = typeof next.role === "string" ? next.role : "custom";
    const timestamp = typeof next.timestamp === "number" ? next.timestamp : Date.now();
    const compact: Record<string, unknown> = {
      role,
      timestamp,
      content: [{ type: "text", text: `Payload externalized (${Math.ceil(bytes / 1024)} KB). Open details or the associated artifact to load it.` }],
      details: { payloadRef: ref, detailsExternalized: true, payloadExternalized: "message" },
    };
    externalized.push({ reason: "message", bytes });
    return { message: compact, externalized };
  }
  return { message: next, externalized };
}

/** Read a payload reference only from this session's private payload directory. */
export async function readPayloadRef(context: PayloadBudgetContext, value: unknown): Promise<string | undefined> {
  const meta = payloadRefMeta(value);
  if (!meta || !/^[a-f0-9]{64}\.(?:b64|txt|json)$/.test(meta.file)) return undefined;
  const file = path.resolve(payloadDirectory(context), meta.file);
  if (path.dirname(file) !== payloadDirectory(context)) return undefined;
  try { return await fs.readFile(file, "utf8"); } catch { return undefined; }
}

/** Restore externalized assistant tool arguments immediately before execution. */
export async function hydrateToolCallInput(input: Record<string, unknown>, context: PayloadBudgetContext): Promise<void> {
  const raw = await readPayloadRef(context, input);
  if (!raw) return;
  try {
    const restored = JSON.parse(raw);
    if (!restored || typeof restored !== "object" || Array.isArray(restored)) throw new Error("not an object");
    for (const key of Object.keys(input)) delete input[key];
    Object.assign(input, restored);
  } catch {
    throw new Error("Tool arguments were externalized but could not be restored. Re-run the tool call.");
  }
}

/**
 * The durable copy is compact, but the model must still see its original
 * image/text/tool arguments on later turns. `context` receives a disposable
 * deep copy, so hydration here never re-inflates AgentSession or JSONL.
 */
export async function hydrateMessagePayloadRefs(message: Record<string, unknown>, context: PayloadBudgetContext): Promise<void> {
  const messageDetails = message.details;
  if (messageDetails && typeof messageDetails === "object" && !Array.isArray(messageDetails)
    && (messageDetails as Record<string, unknown>).payloadExternalized === "message") {
    const raw = await readPayloadRef(context, (messageDetails as Record<string, unknown>).payloadRef);
    if (raw !== undefined) {
      try {
        const restored = JSON.parse(raw);
        if (restored && typeof restored === "object" && !Array.isArray(restored)) {
          for (const key of Object.keys(message)) delete message[key];
          Object.assign(message, restored);
        }
      } catch { /* retain actionable persisted preview if storage is corrupt */ }
    }
  }
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "image") {
      const raw = await readPayloadRef(context, { [PAYLOAD_REF_KEY]: record[PAYLOAD_REF_KEY] });
      if (raw !== undefined) {
        record.data = raw;
        delete record[PAYLOAD_REF_KEY];
      }
    }
    if (record.type === "toolCall" && record.arguments && typeof record.arguments === "object") {
      await hydrateToolCallInput(record.arguments as Record<string, unknown>, context);
    }
    if (record.type === "text" && record.payloadRef) {
      const raw = await readPayloadRef(context, record.payloadRef);
      if (raw !== undefined) {
        record.text = raw;
        delete record.payloadRef;
      }
    }
  }
}
