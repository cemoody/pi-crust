import { describe, expect, it } from "vitest";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

const deck: PresentationDeck = {
  title: "Embed Test",
  theme: "light",
  slides: [
    { template: "title", title: "Hello", subtitle: "World" },
    { template: "metric", title: "Numbers", stats: [{ value: "42", label: "answer" }] },
  ],
};

describe("compileRevealHtml embedded option (competing-arrows fix)", () => {
  it("renders the iframe's own deck-controls nav by default", () => {
    const html = compileRevealHtml(deck);
    expect(html).toContain('class="deck-controls"');
    expect(html).toContain("data-prev");
    expect(html).toContain("data-next");
  });

  it("omits deck-controls when embedded (host supplies the only nav)", () => {
    const html = compileRevealHtml(deck, { embedded: true });
    expect(html).not.toContain('class="deck-controls"');
    // Keyboard/swipe/postMessage handlers must still be present.
    expect(html).toContain("pi-deck-nav");
    expect(html).toContain("keydown");
  });

  it("still exposes the slide-state counter span when not embedded", () => {
    expect(compileRevealHtml(deck)).toContain("data-counter");
  });
});

describe("compileRevealHtml letterbox (title-slide crop fix)", () => {
  it("renders the deck as a fit-to-viewport 16:9 container", () => {
    const html = compileRevealHtml(deck);
    expect(html).toContain("container-type:size");
    expect(html).toContain("min(100vw,calc(100vh * 16 / 9))");
    expect(html).toContain("min(100vh,calc(100vw * 9 / 16))");
  });

  it("sizes slide content with container-query units so it scales instead of cropping", () => {
    const html = compileRevealHtml(deck);
    // Title/headlines now use cqw rather than raw vw.
    expect(html).toContain("font-size:5cqw");
    expect(html).toMatch(/padding:5\.2cqw 5\.8cqw 4\.2cqw/);
    // Print path keeps full-page vw sizing and disables containment.
    expect(html).toContain("container-type:normal");
    expect(html).toContain("height:56.25vw");
  });
});
