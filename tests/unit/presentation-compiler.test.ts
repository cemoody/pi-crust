import { describe, expect, it } from "vitest";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import { coercePresentationDeck, presentationFallbackMarkdown, validatePresentationDeck } from "../../src/presentations/schema.js";

const deck = {
  title: "Executive Signal Brief",
  subtitle: "Weekly executive update",
  theme: "light",
  slides: [
    { template: "title", title: "Executive Signal Brief", subtitle: "Demand and pricing signals" },
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
    expect(html).toContain("Executive Signal Brief");
    expect(html).toContain("Escape &lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("<script></h1>");
  });

  it("generates fallback markdown for non-presentation clients", () => {
    const markdown = presentationFallbackMarkdown(deck);

    expect(markdown).toContain("# Executive Signal Brief");
    expect(markdown).toContain("## 2. What changed");
    expect(markdown).toContain("- Permit velocity improved");
    expect(markdown).toContain("**$25B**");
  });
});

describe("html passthrough slides", () => {
  it("uses slide.html directly in the compiled deck", () => {
    const passthrough = {
      title: "Pack deck",
      slides: [
        { html: "<div class=\"brainco-title\"><h1>Hello</h1></div>" },
        { html: "<div class=\"brainco-team\">Team</div>", template: "team-grid" },
      ],
    } as const;
    const html = compileRevealHtml(passthrough);
    expect(html).toContain("<div class=\"brainco-title\"><h1>Hello</h1></div>");
    expect(html).toContain("<div class=\"brainco-team\">Team</div>");
    expect(html).toContain("data-template=\"team-grid\"");
  });

  // Regression: BrainCo (and other template packs) ship layout HTML that
  // contains its OWN `<div class="slide">` inside the passthrough payload.
  // Before scoping, the deck's `.slide` selector matched both pi-crust's
  // outer <section class="slide"> AND the inner brainco <div class="slide">,
  // so a 7-slide pack deck reported 14 slides and rendered every page
  // empty (the inner divs hit the global `.slide { display: none }` rule).
  // The compiled CSS + nav JS must scope to direct `.deck > .slide`.
  it("scopes .slide CSS + nav to .deck > .slide so passthrough HTML can use its own .slide class", () => {
    const deck = {
      title: "Brand deck",
      slides: [
        { html: "<div class=\"slide brainco-cover\"><h1>One</h1></div>" },
        { html: "<div class=\"slide brainco-bullets\"><h1>Two</h1></div>" },
      ],
    } as const;
    const html = compileRevealHtml(deck);
    // CSS rule must target direct children only, never the bare `.slide`.
    expect(html).toMatch(/\.deck>\.slide\{position:absolute/);
    expect(html).toMatch(/\.deck>\.slide\.active\{display:block\}/);
    expect(html).not.toMatch(/(?<![>.\-])\.slide\{position:absolute/);
    // Deck-navigator JS must use the same scoped selector so inner
    // .slide divs from passthrough HTML aren't counted.
    expect(html).toContain("querySelectorAll('.deck>.slide')");
    expect(html).not.toContain("querySelectorAll('.slide')");
  });
});

describe("templatePack-aware compile", () => {
  it("compileRevealHtmlAsync resolves slide.layout via the templatePackResolver", async () => {
    const { compileRevealHtmlAsync } = await import("../../src/presentations/reveal.js");
    const packDeck = {
      title: "Pack deck",
      templatePack: "brainco",
      slides: [
        { layout: "title-light", slots: { primary: "Q4 Strategy" } },
        { layout: "contents",    slots: { item1Label: "Intro" } },
      ],
    } as const;

    const calls: Array<{ packId: string; layout: string; slots: Record<string, unknown> }> = [];
    const resolver = async (packId: string, layout: string, slots: Record<string, unknown>) => {
      calls.push({ packId, layout, slots });
      return `<div class="${layout}">${slots.primary ?? slots.item1Label ?? "?"}</div>`;
    };
    const html = await compileRevealHtmlAsync(packDeck, { templatePackResolver: resolver });

    expect(calls.length).toBe(2);
    expect(calls[0]?.packId).toBe("brainco");
    expect(calls[0]?.layout).toBe("title-light");
    expect(calls[0]?.slots.page).toBe(1);
    expect(calls[1]?.slots.page).toBe(2);
    expect(html).toContain('<div class="title-light">Q4 Strategy</div>');
    expect(html).toContain('<div class="contents">Intro</div>');
  });
});

describe("templatePack-aware compile with real brainco pack", () => {
  it("compileRevealHtmlAsync + brainco renderSlide produces a 2-slide BrainCo deck", async () => {
    const { compileRevealHtmlAsync } = await import("../../src/presentations/reveal.js");
    let renderBrainCoSlide: ((k: string, s?: Record<string, unknown>) => Promise<string>) | null = null;
    try {
      const url = "/home/coder/brainco-templates/render.mjs";
      // Wrap in eval to keep tsc from statically resolving the path; the
      // pack lives outside the repo and isn't present on CI.
      // eslint-disable-next-line no-eval
      const dynamicImport = eval("(p) => import(p)") as (p: string) => Promise<{ renderBrainCoSlide?: typeof renderBrainCoSlide; renderSlide?: typeof renderBrainCoSlide }>;
      const mod = await dynamicImport(url);
      renderBrainCoSlide = mod.renderBrainCoSlide ?? mod.renderSlide ?? null;
    } catch { /* pack not present on CI; skip */ }
    if (!renderBrainCoSlide) return;

    const packDeck = {
      title: "Q4 Strategy",
      templatePack: "brainco",
      slides: [
        { layout: "title-light", slots: { primary: "Q4 Strategy", secondary: "What's next", date: "Nov 2025", client: "ACME" } },
        { layout: "contents",    slots: { item1Label: "Intro", item2Label: "Plan" } },
      ],
    } as const;

    const html = await compileRevealHtmlAsync(packDeck, {
      templatePackResolver: async (_pack, layout, slots) => renderBrainCoSlide!(layout, slots),
    });

    expect(html).toContain("Q4 Strategy");
    expect(html).toContain("What's next");
    expect(html).toContain("ACME");
    expect(html).toContain(">Intro<");
    expect(html).toContain(">Plan<");
    expect(html).toContain('<p class="page">1</p>');
    expect(html).toContain('<p class="page">2</p>');
  });
});
