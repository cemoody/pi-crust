/**
 * Public contract for editable presentation deck persistence.
 *
 * The presentation extension owns the HTTP routes and on-disk writes; browser
 * consumers own optimistic state. This module is their shared, framework-free
 * vocabulary so either side can evolve without coupling route payload parsing
 * to React state.
 */
import { isPresentationDeck, type PresentationDeck } from "./schema.js";
import type { DeckPatchOp } from "./patch.js";

export interface PersistedPresentationDeck {
  readonly version: 1;
  readonly deckId: string;
  readonly updatedAt: number;
  readonly deck: PresentationDeck;
}

export interface PresentationDeckPatchRequest {
  readonly ops: readonly DeckPatchOp[];
  /** Required only when this PATCH is the first persisted edit for a deck. */
  readonly initial?: PresentationDeck;
}

/**
 * Narrows an untrusted HTTP payload to the persistence envelope emitted by
 * the presentations extension. A malformed successful response is treated as
 * no confirmed deck rather than becoming UI state.
 */
export function parsePersistedPresentationDeck(value: unknown): PersistedPresentationDeck | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1
    || typeof envelope.deckId !== "string"
    || !Number.isFinite(envelope.updatedAt)
    || !isPresentationDeck(envelope.deck)) {
    return null;
  }
  return envelope as unknown as PersistedPresentationDeck;
}
