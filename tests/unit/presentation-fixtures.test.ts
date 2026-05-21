import { describe, expect, it } from "vitest";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import { validatePresentationDeck, type PresentationDeck } from "../../src/presentations/schema.js";

const fixtureDeck: PresentationDeck = {
  title: "Template matrix",
  theme: "light",
  slides: [
    { template: "title", title: "Executive summary", subtitle: "Primary and secondary title" },
    { template: "quote", quote: "Technology shapes how we think and work.", attribution: "Alan Turing" },
    { template: "title-bullets", title: "Key points", bullets: [{ text: "First point", detail: "Supporting detail" }, "Second point"] },
    { template: "metric", title: "Large number", stats: [{ value: "100%", label: "coverage" }, { value: "$25B", label: "market" }] },
    { template: "columns", title: "Team grid", columns: [
      { title: "Person A", body: "Role", bullets: ["Experience"] },
      { title: "Person B", body: "Role", bullets: ["Experience"] },
      { title: "Person C", body: "Role", bullets: ["Experience"] },
    ] },
    { template: "image-split", title: "Image slide", body: "Narrative beside image", image: { src: "chart.svg", alt: "Chart" } },
    { template: "process", title: "Path forward", fragments: ["Discover", "Pilot", "Scale"] },
  ],
};

describe("presentation template fixture matrix", () => {
  it("validates representative presentation layout families", () => {
    expect(validatePresentationDeck(fixtureDeck)).toEqual({ ok: true, errors: [] });
  });

  it("renders deterministic self-contained HTML for each template family", () => {
    const first = compileRevealHtml(fixtureDeck);
    const second = compileRevealHtml(fixtureDeck);

    expect(second).toBe(first);
    for (const template of ["quote", "title-bullets", "metric", "columns", "image-split", "process"]) {
      expect(first).toContain(`data-template=\"${template}\"`);
    }
    expect(first).toContain("alt=\"Chart\"");
    expect(first).toContain("Discover");
  });

  it("escapes user content while keeping the deck script shell intact", () => {
    const html = compileRevealHtml({ title: "Unsafe", slides: [{ title: "<img src=x onerror=alert(1)>", bullets: ["A & B"] }] });

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("<script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });
});
