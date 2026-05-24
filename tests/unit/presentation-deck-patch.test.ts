import { describe, expect, it } from "vitest";
import {
  applyDeckPatch,
  EDITABLE_PATH_ALLOWLIST,
  isEditablePath,
  type DeckPatchOp,
} from "../../src/presentations/patch.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

function baseDeck(): PresentationDeck {
  return {
    title: "Executive Signal Brief",
    subtitle: "Demand, weather, and pricing signals",
    confidential: "Confidential and Proprietary",
    slides: [
      { template: "title", title: "Executive Signal Brief", subtitle: "Demand, weather, and pricing signals" },
      {
        template: "title-bullets",
        title: "What changed",
        body: "Quick recap of the week.",
        bullets: [
          "Pricing pressure remains category-specific",
          { text: "Permit velocity improved", detail: "Southwest fastest." },
        ],
        stats: [{ value: "12%", label: "Permit growth" }],
        columns: [{ title: "Risks", body: "Storm exposure shifted east.", bullets: ["Coastal metros"] }],
        notes: "Speaker notes",
        fragments: ["First", "Second"],
      },
      {
        template: "html",
        html: "<section>pre-rendered</section>",
        layout: "title-light",
        slots: { primary: "Q4" },
      },
    ],
  };
}

describe("applyDeckPatch — pure function", () => {
  it("returns a new deck with a string leaf replaced (immutable input)", () => {
    const deck = baseDeck();
    const next = applyDeckPatch(deck, [{ op: "replace", path: "/slides/0/title", value: "NEW" }]);
    expect(next.slides[0]!.title).toBe("NEW");
    // input not mutated
    expect(deck.slides[0]!.title).toBe("Executive Signal Brief");
    expect(next).not.toBe(deck);
  });

  it("replaces a deck-level field", () => {
    const next = applyDeckPatch(baseDeck(), [{ op: "replace", path: "/title", value: "Renamed" }]);
    expect(next.title).toBe("Renamed");
  });

  it("replaces a string bullet by index", () => {
    const next = applyDeckPatch(baseDeck(), [
      { op: "replace", path: "/slides/1/bullets/0", value: "Edited bullet" },
    ]);
    expect(next.slides[1]!.bullets?.[0]).toBe("Edited bullet");
  });

  it("replaces an object-bullet's text and detail independently", () => {
    const next = applyDeckPatch(baseDeck(), [
      { op: "replace", path: "/slides/1/bullets/1/text", value: "Permits accelerated" },
      { op: "replace", path: "/slides/1/bullets/1/detail", value: "Southwest fastest, Southeast close behind." },
    ]);
    const bullet = next.slides[1]!.bullets?.[1];
    expect(typeof bullet === "object" && bullet !== null ? bullet.text : null).toBe("Permits accelerated");
    expect(typeof bullet === "object" && bullet !== null ? bullet.detail : null).toBe(
      "Southwest fastest, Southeast close behind.",
    );
  });

  it("replaces stats, columns.body, columns.bullets and fragments", () => {
    const next = applyDeckPatch(baseDeck(), [
      { op: "replace", path: "/slides/1/stats/0/value", value: "15%" },
      { op: "replace", path: "/slides/1/stats/0/label", value: "Updated label" },
      { op: "replace", path: "/slides/1/columns/0/body", value: "Updated risks" },
      { op: "replace", path: "/slides/1/columns/0/bullets/0", value: "Inland metros too" },
      { op: "replace", path: "/slides/1/fragments/1", value: "Last" },
      { op: "replace", path: "/slides/1/notes", value: "Updated notes" },
    ]);
    expect(next.slides[1]!.stats?.[0]).toEqual({ value: "15%", label: "Updated label" });
    expect(next.slides[1]!.columns?.[0]?.body).toBe("Updated risks");
    expect(next.slides[1]!.columns?.[0]?.bullets?.[0]).toBe("Inland metros too");
    expect(next.slides[1]!.fragments?.[1]).toBe("Last");
    expect(next.slides[1]!.notes).toBe("Updated notes");
  });

  it("rejects ops with paths outside the allowlist", () => {
    for (const forbidden of [
      "/slides/2/html",
      "/slides/2/layout",
      "/slides/2/slots/primary",
      "/slides/0/image/src",
      "/logo/src",
      "/theme",
      "/templatePack",
    ]) {
      expect(() =>
        applyDeckPatch(baseDeck(), [{ op: "replace", path: forbidden, value: "x" } as DeckPatchOp]),
      ).toThrowError(/not editable/i);
    }
  });

  it("rejects non-string values", () => {
    expect(() =>
      applyDeckPatch(baseDeck(), [{ op: "replace", path: "/title", value: 42 as unknown as string }]),
    ).toThrowError(/string/i);
    expect(() =>
      applyDeckPatch(baseDeck(), [{ op: "replace", path: "/title", value: null as unknown as string }]),
    ).toThrowError(/string/i);
  });

  it("rejects unknown op types (only 'replace' is supported)", () => {
    expect(() =>
      applyDeckPatch(baseDeck(), [{ op: "add", path: "/title", value: "x" } as unknown as DeckPatchOp]),
    ).toThrowError(/replace/i);
  });

  it("rejects out-of-bounds array indices", () => {
    expect(() =>
      applyDeckPatch(baseDeck(), [{ op: "replace", path: "/slides/99/title", value: "x" }]),
    ).toThrowError(/does not resolve/i);
    expect(() =>
      applyDeckPatch(baseDeck(), [{ op: "replace", path: "/slides/1/bullets/9", value: "x" }]),
    ).toThrowError(/does not resolve/i);
  });

  it("re-validates the patched deck; rejects edits that blank required fields", () => {
    expect(() =>
      applyDeckPatch(baseDeck(), [{ op: "replace", path: "/title", value: "" }]),
    ).toThrowError(/title is required|deck/i);
  });

  it("is atomic across multi-op batches: a single bad op aborts all", () => {
    const deck = baseDeck();
    expect(() =>
      applyDeckPatch(deck, [
        { op: "replace", path: "/slides/0/title", value: "A" },
        { op: "replace", path: "/slides/0/html", value: "B" }, // forbidden
      ]),
    ).toThrow();
    // input still untouched
    expect(deck.slides[0]!.title).toBe("Executive Signal Brief");
  });
});

describe("EDITABLE_PATH_ALLOWLIST + isEditablePath", () => {
  it("matches every allow-listed path family", () => {
    for (const path of [
      "/title",
      "/subtitle",
      "/confidential",
      "/slides/0/title",
      "/slides/12/subtitle",
      "/slides/0/eyebrow",
      "/slides/0/body",
      "/slides/0/quote",
      "/slides/0/attribution",
      "/slides/0/notes",
      "/slides/0/bullets/3",
      "/slides/0/bullets/3/text",
      "/slides/0/bullets/3/detail",
      "/slides/0/stats/2/value",
      "/slides/0/stats/2/label",
      "/slides/0/columns/1/title",
      "/slides/0/columns/1/body",
      "/slides/0/columns/1/bullets/0",
      "/slides/0/columns/1/bullets/0/text",
      "/slides/0/columns/1/bullets/0/detail",
      "/slides/0/fragments/0",
    ]) {
      expect(isEditablePath(path)).toBe(true);
    }
  });

  it("rejects forbidden paths", () => {
    for (const path of [
      "/slides/0/html",
      "/slides/0/layout",
      "/slides/0/slots/primary",
      "/slides/0/image/src",
      "/slides/0/image/alt",
      "/logo/src",
      "/theme",
      "/templatePack",
      "/slides", // top-level array
      "/slides/0", // whole slide
      "/", // root
      "",
      "title", // missing leading slash
    ]) {
      expect(isEditablePath(path)).toBe(false);
    }
  });

  it("exposes the allowlist as a stable named export", () => {
    expect(Array.isArray(EDITABLE_PATH_ALLOWLIST)).toBe(true);
    expect(EDITABLE_PATH_ALLOWLIST.length).toBeGreaterThan(0);
  });
});
