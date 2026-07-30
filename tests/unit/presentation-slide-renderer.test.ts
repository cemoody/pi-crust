import { describe, expect, it } from "vitest";
import { renderDeckSlide } from "../../src/presentations/reveal-slide-renderer.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

const deck: PresentationDeck = {
  id: "deck-1",
  title: "Product review",
  confidential: "Internal",
  logo: { src: "logo.png", alt: "Company" },
  slides: [],
};

describe("renderDeckSlide", () => {
  it("renders editable structured content with resolved assets and brand chrome", () => {
    const html = renderDeckSlide(
      deck,
      {
        title: "Results",
        bullets: [{ text: "Retention", detail: "Up 12%" }],
        image: { src: "chart.png", alt: "Quarterly chart" },
        notes: "Discuss drivers",
      },
      2,
      true,
      { editable: true, assetResolver: (src) => `/assets/${src}` },
    );

    expect(html).toContain('class="slide slide-image-split active"');
    expect(html).toContain('data-deck-path="/slides/2/title" contenteditable="plaintext-only"');
    expect(html).toContain('data-deck-path="/slides/2/bullets/0/text" contenteditable="plaintext-only"');
    expect(html).toContain('src="/assets/chart.png" alt="Quarterly chart"');
    expect(html).toContain('src="/assets/logo.png" alt="Company"');
    expect(html).toContain("Discuss drivers");
    expect(html).toContain("Internal");
  });

  it("preserves full-document template-pack markup and wraps a fixed canvas for scaling", () => {
    const html = renderDeckSlide(
      deck,
      {
        template: "brand-cover",
        html: '<style>html,body{width:1920px;height:1080px}</style><body class="dark"><div class="slide">Cover</div></body>',
      },
      0,
    );

    expect(html).toContain('class="slide slide-brand-cover dark active"');
    expect(html).toContain('data-non-editable="templated" data-canvas-w="1920" data-canvas-h="1080"');
    expect(html).toContain('<div class="slide-scaler" style="width:1920px;height:1080px">');
    expect(html).toContain('<div class="slide">Cover</div>');
  });
});
