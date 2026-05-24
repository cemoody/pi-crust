/**
 * Pure deck-patch logic shared by the server (`extensions/presentations`)
 * and the frontend (`PresentationArtifactCard`). Implements a tiny subset of
 * RFC6902:
 *   - only `replace` ops
 *   - only string values
 *   - only paths in {@link EDITABLE_PATH_ALLOWLIST}
 *   - the patched deck must still pass {@link validatePresentationDeck}
 */
import { validatePresentationDeck, type PresentationDeck } from "./schema.js";

export interface DeckPatchOp {
  readonly op: "replace";
  readonly path: string;
  readonly value: string;
}

/**
 * Regex patterns describing every JSON pointer that is safe to edit
 * in-place. The server treats these as authoritative; the frontend mirrors
 * them only for hint rendering. Numeric segments use `\d+`; everything else
 * is a literal match.
 */
export const EDITABLE_PATH_ALLOWLIST: readonly RegExp[] = Object.freeze([
  /^\/title$/,
  /^\/subtitle$/,
  /^\/confidential$/,
  /^\/slides\/\d+\/(title|subtitle|eyebrow|body|quote|attribution|notes)$/,
  /^\/slides\/\d+\/bullets\/\d+$/,
  /^\/slides\/\d+\/bullets\/\d+\/(text|detail)$/,
  /^\/slides\/\d+\/stats\/\d+\/(value|label)$/,
  /^\/slides\/\d+\/columns\/\d+\/(title|body)$/,
  /^\/slides\/\d+\/columns\/\d+\/bullets\/\d+$/,
  /^\/slides\/\d+\/columns\/\d+\/bullets\/\d+\/(text|detail)$/,
  /^\/slides\/\d+\/fragments\/\d+$/,
]);

export function isEditablePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  return EDITABLE_PATH_ALLOWLIST.some((pattern) => pattern.test(path));
}

/**
 * Apply a batch of patch ops atomically. Returns a new deck (input
 * unchanged). Throws if any op is malformed, unauthorized, or if the
 * resulting deck fails validation — in that case no partial change is
 * exposed.
 */
export function applyDeckPatch(deck: PresentationDeck, ops: readonly DeckPatchOp[]): PresentationDeck {
  if (!Array.isArray(ops)) throw new Error("ops must be an array");
  // Deep clone so we never mutate the caller's input even if validation throws
  // partway through. Decks are small enough for JSON clone to be fine.
  const next = JSON.parse(JSON.stringify(deck)) as Record<string, unknown>;
  for (const op of ops) {
    if (!op || typeof op !== "object") throw new Error("malformed patch op");
    if (op.op !== "replace") throw new Error(`only 'replace' ops are supported, got '${op.op}'`);
    if (typeof op.value !== "string") throw new Error(`only string values are supported (path: ${op.path})`);
    if (!isEditablePath(op.path)) throw new Error(`path not editable: ${op.path}`);
    setAtJsonPointer(next, op.path, op.value);
  }
  const validation = validatePresentationDeck(next);
  if (!validation.ok) throw new Error(`patched deck invalid: ${validation.errors.join("; ")}`);
  return next as unknown as PresentationDeck;
}

function setAtJsonPointer(root: Record<string, unknown>, pointer: string, value: string): void {
  const segments = pointer.split("/").slice(1).map(decodePointerSegment);
  if (segments.length === 0) throw new Error(`path does not resolve: ${pointer}`);
  let cursor: unknown = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    cursor = stepInto(cursor, segment, pointer);
  }
  const last = segments[segments.length - 1]!;
  assignLeaf(cursor, last, value, pointer);
}

function stepInto(cursor: unknown, segment: string, pointer: string): unknown {
  if (Array.isArray(cursor)) {
    const idx = Number(segment);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
      throw new Error(`path does not resolve: ${pointer}`);
    }
    return cursor[idx];
  }
  if (cursor && typeof cursor === "object") {
    const obj = cursor as Record<string, unknown>;
    if (!(segment in obj)) throw new Error(`path does not resolve: ${pointer}`);
    return obj[segment];
  }
  throw new Error(`path does not resolve: ${pointer}`);
}

function assignLeaf(cursor: unknown, segment: string, value: string, pointer: string): void {
  if (Array.isArray(cursor)) {
    const idx = Number(segment);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
      throw new Error(`path does not resolve: ${pointer}`);
    }
    const existing = cursor[idx];
    if (existing !== undefined && typeof existing !== "string" && !(existing && typeof existing === "object")) {
      throw new Error(`path does not resolve to a string leaf: ${pointer}`);
    }
    // If the existing slot is an object (e.g. bullet object), refuse to
    // overwrite the whole object via a leaf-index path — the caller must
    // address `/text` or `/detail`. The allowlist also enforces this.
    if (existing && typeof existing === "object") {
      throw new Error(`path does not resolve to a string leaf: ${pointer}`);
    }
    cursor[idx] = value;
    return;
  }
  if (cursor && typeof cursor === "object") {
    (cursor as Record<string, unknown>)[segment] = value;
    return;
  }
  throw new Error(`path does not resolve: ${pointer}`);
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
