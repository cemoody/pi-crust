import { describe, expect, it } from "vitest";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

function deck(): PresentationDeck {
  return {
    title: "Executive Signal Brief",
    subtitle: "Demand, weather, and pricing signals",
    slides: [
      { template: "title", title: "Executive Signal Brief", subtitle: "Demand, weather, and pricing signals" },
      {
        template: "title-bullets",
        title: "What changed",
        body: "Recap.",
        bullets: ["First", { text: "Second", detail: "More" }],
        stats: [{ value: "12%", label: "Permits" }],
        columns: [{ title: "Risks", body: "East coast", bullets: ["Coastal"] }],
        notes: "Speaker notes",
        fragments: ["A", "B"],
      },
      {
        // template-pack pre-rendered slide — must be read-only
        template: "html",
        html: "<section data-test=\"pre-rendered\">x</section>",
      },
    ],
  };
}

describe("compileRevealHtml — non-editable (default)", () => {
  it("does NOT include contenteditable or data-deck-path attributes by default", () => {
    const html = compileRevealHtml(deck());
    expect(html).not.toMatch(/contenteditable/);
    expect(html).not.toMatch(/data-deck-path/);
  });
});

describe("compileRevealHtml — editable mode", () => {
  it("marks editable text nodes with contenteditable=plaintext-only and a JSON pointer", () => {
    const html = compileRevealHtml(deck(), { editable: true });
    // Slide-level fields
    expect(html).toContain('data-deck-path="/slides/1/title"');
    expect(html).toContain('data-deck-path="/slides/1/body"');
    expect(html).toContain('data-deck-path="/slides/1/notes"');
    // Bullets
    expect(html).toContain('data-deck-path="/slides/1/bullets/0"');
    expect(html).toContain('data-deck-path="/slides/1/bullets/1/text"');
    expect(html).toContain('data-deck-path="/slides/1/bullets/1/detail"');
    // Stats / columns / fragments
    expect(html).toContain('data-deck-path="/slides/1/stats/0/value"');
    expect(html).toContain('data-deck-path="/slides/1/stats/0/label"');
    expect(html).toContain('data-deck-path="/slides/1/columns/0/title"');
    expect(html).toContain('data-deck-path="/slides/1/columns/0/body"');
    expect(html).toContain('data-deck-path="/slides/1/columns/0/bullets/0"');
    expect(html).toContain('data-deck-path="/slides/1/fragments/0"');
    expect(html).toContain('data-deck-path="/slides/1/fragments/1"');
    // Every data-deck-path carries contenteditable=plaintext-only
    const matches = html.match(/data-deck-path="[^"]+"[^>]*/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) expect(m).toMatch(/contenteditable="plaintext-only"/);
  });

  it("emits a non-editable marker for template-pack pre-rendered slides", () => {
    const html = compileRevealHtml(deck(), { editable: true });
    // slide index 2 is the template-pack slide; nothing inside it is editable
    expect(html).toContain('data-slide-index="2"');
    expect(html).toContain('data-non-editable="templated"');
    // No contenteditable attr inside that slide's <section>
    const slide2 = /data-slide-index="2"[^]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(slide2).not.toMatch(/contenteditable/);
  });

  it("escapes hostile content in editable mode (no XSS)", () => {
    const evil: PresentationDeck = {
      title: "ok",
      slides: [{ title: "<img src=x onerror=alert(1)>", body: "</section><script>boom()</script>" }],
    };
    const html = compileRevealHtml(evil, { editable: true });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>boom()");
    // Escaped form is present
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;boom()");
  });

  it("injects a wrapper script that postMessages pi-deck-edit on input", () => {
    const html = compileRevealHtml(deck(), { editable: true });
    expect(html).toMatch(/window\.parent\.postMessage\s*\(/);
    expect(html).toMatch(/pi-deck-edit/);
    expect(html).toMatch(/data-deck-path/);
  });

  it("adds a CSS rule highlighting focused editable elements", () => {
    const html = compileRevealHtml(deck(), { editable: true });
    expect(html).toMatch(/\[contenteditable\][^{}]*:focus/);
  });
});
