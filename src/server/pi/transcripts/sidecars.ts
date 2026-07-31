import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { isRecord } from "../../../shared/util.js";

/**
 * Bodies at or above this size do not belong in Pi's append-only JSONL. The
 * transcript keeps a small, standard JSON reference and the immutable body is
 * stored beside the session in a content-addressed sidecar store instead.
 */
export const MAX_INLINE_TRANSCRIPT_BODY_BYTES = 64 * 1024;
const SIDECAR_VERSION = 1;
const SIDECAR_DIRECTORY_SUFFIX = ".pi-crust-sidecars";
const SIDECAR_FIELD = "__piCrustSidecar";

export type TranscriptSidecarKind = "tool-content" | "tool-artifact" | "details";

export interface TranscriptBodyReference {
  readonly version: 1;
  readonly id: string;
  readonly bytes: number;
  readonly kind: TranscriptSidecarKind;
}

interface StoredSidecar {
  readonly version: 1;
  readonly id: string;
  readonly bytes: number;
  readonly body: unknown;
}

export function transcriptSidecarReference(value: unknown): TranscriptBodyReference | undefined {
  return isRecord(value) ? parseReference(value[SIDECAR_FIELD]) : undefined;
}

function parseReference(candidate: unknown): TranscriptBodyReference | undefined {
  if (!isRecord(candidate)) return undefined;
  if (candidate.version !== SIDECAR_VERSION || typeof candidate.id !== "string" || !/^[a-f0-9]{64}$/.test(candidate.id)) return undefined;
  if (typeof candidate.bytes !== "number" || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0) return undefined;
  if (candidate.kind !== "tool-content" && candidate.kind !== "tool-artifact" && candidate.kind !== "details") return undefined;
  return { version: 1, id: candidate.id, bytes: candidate.bytes, kind: candidate.kind };
}

/** Read and checksum a referenced body. Invalid/missing sidecars deliberately
 * return undefined rather than reading an arbitrary path or serving corrupt
 * content. */
export async function readTranscriptSidecar(
  sessionFile: string,
  reference: TranscriptBodyReference,
): Promise<unknown | undefined> {
  const file = sidecarPath(sessionFile, reference.id);
  let parsed: unknown;
  try { parsed = JSON.parse(await fsp.readFile(file, "utf8")); } catch { return undefined; }
  if (!isRecord(parsed) || parsed.version !== SIDECAR_VERSION || parsed.id !== reference.id || parsed.bytes !== reference.bytes || !("body" in parsed)) return undefined;
  const encoded = JSON.stringify(parsed.body);
  if (Buffer.byteLength(encoded, "utf8") !== reference.bytes || sha256(encoded) !== reference.id) return undefined;
  return parsed.body;
}

/** Hydrate references in raw Pi session messages before their normal
 * toSessionMessages() fan-out. The exact original shapes are restored, so all
 * existing UI APIs and extension renderers remain source-compatible. */
export async function hydrateTranscriptSidecars(
  sessionFile: string,
  messages: readonly unknown[],
): Promise<unknown[]> {
  return Promise.all(messages.map(async (message) => {
    if (!isRecord(message)) return message;
    let next: Record<string, unknown> = message as Record<string, unknown>;
    if (message.role === "toolResult") {
      if (Array.isArray(message.content)) {
        const refBlock = message.content.find((block) => isRecord(block) && parseReference(block[SIDECAR_FIELD]));
        const reference = refBlock && isRecord(refBlock) ? parseReference(refBlock[SIDECAR_FIELD]) : undefined;
        if (reference?.kind === "tool-content") {
          const body = await readTranscriptSidecar(sessionFile, reference);
          if (body !== undefined) next = { ...next, content: body };
        }
      }
      if (isRecord(next.details)) {
        const details = next.details as Record<string, unknown>;
        const reference = transcriptSidecarReference(details.piRemoteControlArtifact);
        if (reference?.kind === "tool-artifact") {
          const body = await readTranscriptSidecar(sessionFile, reference);
          if (body !== undefined) next = { ...next, details: { ...details, piRemoteControlArtifact: body } };
        }
      }
    }
    if ((message.role === "custom" || typeof message.customType === "string") && isRecord(next.details)) {
      const reference = transcriptSidecarReference(next.details);
      if (reference?.kind === "details") {
        const body = await readTranscriptSidecar(sessionFile, reference);
        if (isRecord(body)) next = { ...next, details: body as Record<string, unknown> };
      }
    }
    return next;
  }));
}

/**
 * Rewrite only oversized *new-style* tool/artifact message bodies to sidecars.
 * The JSONL itself stays valid Pi data: tool output becomes a normal text
 * block, and artifact/details stubs retain ordinary object metadata. Older
 * transcripts are untouched and remain readable by all existing code.
 *
 * This runs after Pi has completed a turn (and therefore finished appending)
 * rather than attempting to interpose on Pi's synchronous SessionManager
 * writer. The rewrite is atomic, sidecars are content-addressed and mode 0600,
 * and an in-process queue prevents overlapping compactions of one transcript.
 */
const inFlight = new Map<string, Promise<SidecarizationResult>>();

export interface SidecarizationResult {
  readonly rewrittenRows: number;
  readonly sidecarBytes: number;
}

export function persistOversizedTranscriptBodies(sessionFile: string): Promise<SidecarizationResult> {
  const resolved = path.resolve(sessionFile);
  const existing = inFlight.get(resolved);
  if (existing) return existing;
  const pending = persistInternal(resolved).finally(() => { inFlight.delete(resolved); });
  inFlight.set(resolved, pending);
  return pending;
}

async function persistInternal(sessionFile: string): Promise<SidecarizationResult> {
  if (!sessionFile.endsWith(".jsonl")) return { rewrittenRows: 0, sidecarBytes: 0 };
  let stat: fs.Stats;
  try { stat = await fsp.stat(sessionFile); } catch { return { rewrittenRows: 0, sidecarBytes: 0 }; }
  if (!stat.isFile()) return { rewrittenRows: 0, sidecarBytes: 0 };

  const tmp = `${sessionFile}.pi-crust-sidecar-tmp-${process.pid}-${crypto.randomUUID()}`;
  let rewrittenRows = 0;
  let sidecarBytes = 0;
  let changed = false;
  const input = fs.createReadStream(sessionFile, { encoding: "utf8" });
  const output = fs.createWriteStream(tmp, { encoding: "utf8", mode: 0o600, flags: "wx" });
  let outputClosed = false;
  try {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      const transformed = await sidecarizeLine(line, sessionFile);
      if (transformed.changed) {
        changed = true;
        rewrittenRows += 1;
        sidecarBytes += transformed.sidecarBytes;
      }
      if (!output.write(`${transformed.line}\n`)) await onceDrain(output);
    }
    await closeWritable(output);
    outputClosed = true;
    // Do not clobber a turn Pi appended while this pass ran. A later agent_end
    // pass will compact that row; preserving Pi's append is more important.
    const after = await fsp.stat(sessionFile);
    if (changed && after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
      await fsp.rename(tmp, sessionFile);
    } else {
      await fsp.rm(tmp, { force: true });
      if (changed) return { rewrittenRows: 0, sidecarBytes: 0 };
    }
    return { rewrittenRows, sidecarBytes };
  } catch (error) {
    if (!outputClosed) output.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    input.destroy();
  }
}

async function sidecarizeLine(line: string, sessionFile: string): Promise<{ line: string; changed: boolean; sidecarBytes: number }> {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return { line, changed: false, sidecarBytes: 0 }; }
  if (!isRecord(entry)) return { line, changed: false, sidecarBytes: 0 };

  const message = entry.type === "message" && isRecord(entry.message)
    ? entry.message as Record<string, unknown>
    : entry.type === "custom_message" ? entry : undefined;
  if (!message) return { line, changed: false, sidecarBytes: 0 };

  let next: Record<string, unknown> = message;
  let changed = false;
  let sidecarBytes = 0;
  const replace = async (key: string, kind: TranscriptSidecarKind, preview: (reference: TranscriptBodyReference) => unknown) => {
    const value = next[key];
    if (value === undefined || transcriptSidecarReference(value)) return;
    const encoded = safeJson(value);
    if (!encoded || Buffer.byteLength(encoded, "utf8") < MAX_INLINE_TRANSCRIPT_BODY_BYTES) return;
    const ref = await writeTranscriptSidecar(sessionFile, kind, value, encoded);
    next = { ...next, [key]: preview(ref) };
    changed = true;
    sidecarBytes += ref.bytes;
  };

  if (message.role === "toolResult") {
    await replace("content", "tool-content", (ref: TranscriptBodyReference) => [{ type: "text", text: sidecarPreviewText(ref) , [SIDECAR_FIELD]: ref }]);
    if (isRecord(next.details)) {
      const details = next.details as Record<string, unknown>;
      const artifact = details.piRemoteControlArtifact;
      if (artifact !== undefined && !transcriptSidecarReference(artifact)) {
        const encoded = safeJson(artifact);
        if (encoded && Buffer.byteLength(encoded, "utf8") >= MAX_INLINE_TRANSCRIPT_BODY_BYTES) {
          const ref = await writeTranscriptSidecar(sessionFile, "tool-artifact", artifact, encoded);
          const stub: Record<string, unknown> = { [SIDECAR_FIELD]: ref };
          if (isRecord(artifact)) {
            for (const key of ["version", "kind", "title", "path", "url", "mimeType", "alt"] as const) {
              const value = artifact[key];
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") stub[key] = value;
            }
          }
          next = { ...next, details: { ...details, piRemoteControlArtifact: stub } };
          changed = true;
          sidecarBytes += ref.bytes;
        }
      }
    }
  }

  // Extension custom messages are the other common source of giant artifact
  // rows. Keep their top-level identifying fields plus a details reference.
  if ((message.role === "custom" || typeof message.customType === "string") && isRecord(next.details)) {
    await replace("details", "details", (ref: TranscriptBodyReference) => ({
      [SIDECAR_FIELD]: ref,
      ...(typeof next.customType === "string" ? { customType: next.customType } : {}),
    }));
  }

  if (!changed) return { line, changed: false, sidecarBytes: 0 };
  const rewritten = entry.type === "message" ? { ...entry, message: next } : next;
  return { line: JSON.stringify(rewritten), changed: true, sidecarBytes };
}

function safeJson(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}

function sidecarPreviewText(reference: TranscriptBodyReference): string {
  return `…[${Math.ceil(reference.bytes / 1024)} KB tool output persisted in pi-crust sidecar]…`;
}

async function writeTranscriptSidecar(
  sessionFile: string,
  kind: TranscriptSidecarKind,
  body: unknown,
  encoded = JSON.stringify(body),
): Promise<TranscriptBodyReference> {
  const bytes = Buffer.byteLength(encoded, "utf8");
  const id = sha256(encoded);
  const reference: TranscriptBodyReference = { version: 1, id, bytes, kind };
  const root = sidecarDirectory(sessionFile);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const target = sidecarPath(sessionFile, id);
  const record: StoredSidecar = { version: 1, id, bytes, body };
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.rename(tmp, target);
  } catch (error: unknown) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Content-addressed collision/deduplication: only reuse a file that passes
    // the same checksum validation readers use.
    if ((await readTranscriptSidecar(sessionFile, reference)) === undefined) throw error;
  }
  return reference;
}

/** Per-transcript directory prevents one session's reference from resolving a
 * body belonging to another and lets deleteSession remove all of its sidecars
 * with no global GC/index. */
export function transcriptSidecarDirectory(sessionFile: string): string {
  return `${path.resolve(sessionFile)}${SIDECAR_DIRECTORY_SUFFIX}`;
}

function sidecarDirectory(sessionFile: string): string {
  return transcriptSidecarDirectory(sessionFile);
}

function sidecarPath(sessionFile: string, id: string): string {
  return path.join(sidecarDirectory(sessionFile), `${id}.json`);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function onceDrain(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

function closeWritable(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => stream.end((error?: Error | null) => error ? reject(error) : resolve()));
}
