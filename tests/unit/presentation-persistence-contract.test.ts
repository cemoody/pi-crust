import { describe, expect, it } from "vitest";
import { applyDeckPatch } from "../../src/presentations/patch.js";
import {
  parsePersistedPresentationDeck,
  type PresentationDeckPatchRequest,
} from "../../src/presentations/persistence.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

const deck: PresentationDeck = {
  id: "exec-brief",
  title: "Executive Signal Brief",
  slides: [{ title: "Signal" }],
};

describe("presentation persistence contract", () => {
  it("round-trips the extension's persisted envelope into an editable deck", () => {
    const response = {
      version: 1,
      deckId: "exec-brief",
      updatedAt: 1_700_000_000_000,
      deck,
    };

    const persisted = parsePersistedPresentationDeck(response);

    expect(persisted).toEqual(response);
    expect(applyDeckPatch(persisted!.deck, [{ op: "replace", path: "/slides/0/title", value: "Updated" }]))
      .toMatchObject({ slides: [{ title: "Updated" }] });
  });

  it("accepts only complete extension envelopes, never malformed success payloads", () => {
    expect(parsePersistedPresentationDeck({ deck })).toBeNull();
    expect(parsePersistedPresentationDeck({ version: 1, deckId: "exec-brief", updatedAt: "now", deck })).toBeNull();
    expect(parsePersistedPresentationDeck({ version: 1, deckId: "exec-brief", updatedAt: 1, deck: { title: "", slides: [] } })).toBeNull();
  });

  it("models the lazy-create PATCH request consumed by the persistence route", () => {
    const request: PresentationDeckPatchRequest = {
      initial: deck,
      ops: [{ op: "replace", path: "/title", value: "Updated Brief" }],
    };

    expect(request).toEqual({
      initial: deck,
      ops: [{ op: "replace", path: "/title", value: "Updated Brief" }],
    });
  });
});
