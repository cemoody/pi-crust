import { describe, expect, it } from "vitest";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import { coercePresentationDeck, presentationFallbackMarkdown, validatePresentationDeck } from "../../src/presentations/schema.js";

const deck = {
  title: "QXO Signal Brief",
  subtitle: "Weekly executive update",
  theme: "brainco",
  slides: [
    { template: "title", title: "QXO Signal Brief", subtitle: "Demand and pricing signals" },
    { template: "title-bullets", title: "What changed", bullets: [{ text: "Permit velocity improved", detail: "Southwest recovered fastest" }, "Roofing demand remains elevated"] },
    { template: "metric", title: "Impact", stats: [{ value: "$25B", label: "addressable branch spend" }] },
  ],
};

describe("presentation deck schema and Reveal-style compiler", () => {
  it("validates deck shape before rendering", () => {
    expect(validatePresentationDeck(deck)).toEqual({ ok: true, errors: [] });
    expect(validatePresentationDeck({ title: "No slides", slides: [] }).ok).toBe(false);
    expect(() => coercePresentationDeck({ slides: [{}] })).toThrow(/title is required/);
  });

  it("compiles a self-contained HTML slide deck with controls and escaped content", () => {
    const html = compileRevealHtml({ ...deck, slides: [...deck.slides, { title: "Escape <script>", body: "A & B" }] });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("data-next");
    expect(html).toContain("QXO Signal Brief");
    expect(html).toContain("Escape &lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("<script></h1>");
  });

  it("generates fallback markdown for non-presentation clients", () => {
    const markdown = presentationFallbackMarkdown(deck);

    expect(markdown).toContain("# QXO Signal Brief");
    expect(markdown).toContain("## 2. What changed");
    expect(markdown).toContain("- Permit velocity improved");
    expect(markdown).toContain("**$25B**");
  });
});
