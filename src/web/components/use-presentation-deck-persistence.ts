import { useEffect, useRef, useState } from "react";
import { applyDeckPatch, type DeckPatchOp } from "../../presentations/patch.js";
import type { PresentationDeck } from "../../presentations/schema.js";

interface UsePresentationDeckPersistenceOptions {
  readonly baseDeck: PresentationDeck | undefined;
  readonly sessionId: string | undefined;
  readonly deckId: string | undefined;
  readonly open: boolean;
  readonly editing: boolean;
}

export interface PresentationDeckPersistence {
  readonly deck: PresentationDeck | undefined;
  readonly persisted: PresentationDeck | null;
  readonly editError: string | null;
  flushEdits(): Promise<void>;
}

/**
 * Hydrates a session deck and owns its optimistic, debounced edit lifecycle.
 * Iframe edit messages are deliberately handled here so the presentation card
 * only coordinates modal UI, while this hook owns all persistence state.
 */
export function usePresentationDeckPersistence({
  baseDeck,
  sessionId,
  deckId,
  open,
  editing,
}: UsePresentationDeckPersistenceOptions): PresentationDeckPersistence {
  const [persisted, setPersisted] = useState<PresentationDeck | null>(null);
  const [optimistic, setOptimistic] = useState<PresentationDeck | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const pendingOpsRef = useRef<DeckPatchOp[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedDeckRef = useRef<PresentationDeck | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    if (!sessionId || !deckId) return;
    let cancelled = false;
    void fetchPersistedDeck(sessionId, deckId).then((deck) => {
      if (deck && !cancelled) setPersisted(deck);
    });
    return () => { cancelled = true; };
  }, [sessionId, deckId]);

  useEffect(() => {
    confirmedDeckRef.current = persisted ?? baseDeck ?? null;
  }, [persisted, baseDeck]);

  const flushEdits = async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const ops = pendingOpsRef.current;
    if (!ops.length || !sessionId || !deckId) return;
    pendingOpsRef.current = [];
    const initial = confirmedDeckRef.current ?? baseDeck;
    try {
      const envelope = await patchDeck(sessionId, deckId, ops, initial);
      if (!envelope) {
        setEditError("Could not save edits");
        setOptimistic(null);
        return;
      }
      if (envelope.deck) {
        setPersisted(envelope.deck);
        setOptimistic(null);
        setEditError(null);
      }
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
      setOptimistic(null);
    }
  };
  flushRef.current = flushEdits;

  useEffect(() => {
    if (!open || !editing) return;
    const onMessage = (event: MessageEvent) => {
      const edit = parseDeckEdit(event.data, deckId);
      if (!edit) return;
      pendingOpsRef.current = pendingOpsRef.current.filter((operation) => operation.path !== edit.path);
      pendingOpsRef.current.push(edit);
      const currentDeck = optimistic ?? persisted ?? baseDeck;
      if (currentDeck) {
        try {
          setOptimistic(applyDeckPatch(currentDeck, [edit]));
        } catch (error) {
          setEditError(error instanceof Error ? error.message : String(error));
        }
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => { void flushRef.current(); }, 500);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, editing, deckId, optimistic, persisted, baseDeck]);

  return { deck: optimistic ?? persisted ?? baseDeck, persisted, editError, flushEdits };
}

async function fetchPersistedDeck(sessionId: string, deckId: string): Promise<PresentationDeck | null> {
  try {
    const response = await fetch(deckUrl(sessionId, deckId));
    if (!response.ok) return null;
    const envelope = await response.json();
    return envelope?.deck && typeof envelope.deck === "object" ? envelope.deck as PresentationDeck : null;
  } catch {
    return null;
  }
}

async function patchDeck(
  sessionId: string,
  deckId: string,
  ops: DeckPatchOp[],
  initial: PresentationDeck | undefined,
): Promise<{ deck?: PresentationDeck } | null> {
  const response = await fetch(deckUrl(sessionId, deckId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops, initial }),
  });
  if (response.ok) return response.json() as Promise<{ deck?: PresentationDeck }>;
  let detail = "Could not save edits";
  try {
    const body = await response.json();
    detail = body?.error ?? detail;
  } catch {
    // A malformed error response still gets the default error message.
  }
  throw new Error(detail);
}

function parseDeckEdit(data: unknown, deckId: string | undefined): DeckPatchOp | null {
  if (!data || typeof data !== "object") return null;
  const message = data as { type?: unknown; deckId?: unknown; path?: unknown; value?: unknown };
  if (message.type !== "pi-deck-edit" || typeof message.path !== "string" || typeof message.value !== "string") return null;
  if (deckId && message.deckId && message.deckId !== deckId) return null;
  return { op: "replace", path: message.path, value: message.value };
}

function deckUrl(sessionId: string, deckId: string): string {
  const apiBase = (import.meta as ImportMeta).env?.VITE_PI_CRUST_API_BASE ?? "";
  return `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/presentations/${encodeURIComponent(deckId)}/deck.json`;
}
