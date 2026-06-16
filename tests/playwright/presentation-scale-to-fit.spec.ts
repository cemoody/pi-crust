import { expect, test } from "@playwright/test";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

// ---------------------------------------------------------------------------
// Regression tests for the "presentation does not scale to fit the viewport"
// bugs (originally RED; green after the scale-to-fit fix in reveal.ts).
//
// Template-pack layouts (e.g. the BrainCo pack used by the QXO deck) ship a
// *fixed* 1920x1080 px canvas:
//
//     html, body { width: 1920px; height: 1080px; }
//     .slide     { width: 1920px; height: 1080px; }
//     .footer    { position: absolute; top: 1031px; }   // near the bottom edge
//
// That HTML is passed through to the reveal compiler via `slide.html` and lands
// inside the deck as a `data-non-editable="templated"` slide. The reveal deck
// is sized `width:100vw;height:100vh` with `body{overflow:hidden}` and applies
// NO scale-to-fit transform to templated slides. So whenever the browser
// viewport (in CSS px) is smaller than 1920x1080 the fixed canvas overflows and
// the bottom chrome (footer / page number / footer rule) is clipped.
//
// This matches the three screenshots the user reported:
//   1. Full screen (viewport < 1080 CSS px tall): footer is cut off.
//   2. Zoom to 90% (viewport grows to >= 1080 CSS px tall): footer reappears.
//   3. Embedded PRC iframe: the 1920x1080 canvas renders at 1:1 with no
//      scaling, so only the top-left corner is visible.
//
// The fix wraps templated slides in a `.slide-scaler` whose runtime transform
// is scale = min(deckW/canvasW, deckH/canvasH), centered, and pins the outer
// deck/section back to the viewport so a pack's leaked `html,body{width:..}`
// and `.slide{width:..}` rules can't resize the deck. These assertions verify
// the whole canvas (incl. footer) fits at any viewport.
// ---------------------------------------------------------------------------

const FIXED_W = 1920;
const FIXED_H = 1080;
const FOOTER_TOP = 1031; // px from the top of the fixed canvas (BrainCo chrome)

// A faithful, self-contained reproduction of a BrainCo-style template-pack
// slide: a fixed 1920x1080 canvas with bottom-anchored footer chrome. This is
// exactly the shape `renderBrainCoSlide("title-light", …)` produces.
const templatedSlideHtml = `<!doctype html><html><head><style>
html,body{margin:0;width:${FIXED_W}px;height:${FIXED_H}px;background:#f9f9f9;color:#111605}
.slide{position:relative;width:${FIXED_W}px;height:${FIXED_H}px;overflow:hidden}
.title{position:absolute;left:120px;top:459px;margin:0;font-size:96px;line-height:.9}
.footer-rule{position:absolute;left:120px;top:1020px;width:1681px;height:1px;background:currentColor}
.footer{position:absolute;left:440px;top:${FOOTER_TOP}px;margin:0;font-size:12px}
.page{position:absolute;left:1796px;top:${FOOTER_TOP}px;margin:0;font-size:12px}
</style></head><body class="light">
<div class="slide" data-testid="brainco-canvas">
  <h1 class="title">QXO Codebase Onboarding</h1>
  <div class="footer-rule"></div>
  <p class="footer" data-testid="deck-footer">Confidential — BrainCo × QXO</p>
  <p class="page">1 / 14</p>
</div>
</body></html>`;

const templatedDeck: PresentationDeck = {
  title: "QXO Codebase Onboarding",
  theme: "light",
  templatePack: "brainco",
  slides: [{ template: "title-light", layout: "title-light", html: templatedSlideHtml }],
};

function htmlForDeck(): string {
  return compileRevealHtml(templatedDeck);
}

// Common "full screen" content viewport on a laptop: WIDER than 16:9 but
// SHORTER than the fixed 1080px canvas in CSS px (matches screenshot #1).
const FULLSCREEN_VP = { width: 1512, height: 860 };

test.describe("presentation scale-to-fit (templated 1920x1080 canvas)", () => {
  test("full screen: footer stays inside the viewport (canvas scaled to fit)", async ({ page }) => {
    await page.setViewportSize(FULLSCREEN_VP);
    await page.setContent(htmlForDeck());

    const footer = page.locator('[data-testid="deck-footer"]');
    await expect(footer).toBeAttached();

    const box = await footer.boundingBox();
    const vp = page.viewportSize()!;
    console.log("viewport =", JSON.stringify(vp));
    console.log("footer box =", JSON.stringify(box));
    await page.screenshot({ path: "test-results/scale-repro-1-fullscreen-clip.png" });

    // The footer must be fully inside the viewport to be visible to the user.
    // Before the fix it sat at ~1031px (top-left of the unscaled fixed canvas),
    // below an 860px-tall viewport => clipped. With scale-to-fit it fits.
    expect(box).not.toBeNull();
    const footerBottom = box!.y + box!.height;
    expect(
      footerBottom,
      `footer bottom (${footerBottom}px) should be inside the ${vp.height}px viewport`,
    ).toBeLessThanOrEqual(vp.height);
  });

  test("embedded iframe: the slide canvas shrinks to fit the viewport", async ({ page }) => {
    // Simulate the PRC embedded artifact: a viewport smaller than the fixed
    // canvas. With scale-to-fit the rendered canvas shrinks to fit; before the
    // fix it rendered at a fixed 1920x1080 and overflowed (screenshot #3).
    await page.setViewportSize({ width: 1100, height: 620 });
    await page.setContent(htmlForDeck());

    const canvas = page.locator('[data-testid="brainco-canvas"]');
    const box = await canvas.boundingBox();
    const vp = page.viewportSize()!;
    console.log("viewport =", JSON.stringify(vp));
    console.log("rendered canvas box =", JSON.stringify(box));
    await page.screenshot({ path: "test-results/scale-repro-3-iframe-overflow.png" });

    expect(box).not.toBeNull();
    // The scaled canvas must fit within the viewport on both axes.
    expect(box!.width, "canvas width should fit the viewport").toBeLessThanOrEqual(vp.width + 1);
    expect(box!.height, "canvas height should fit the viewport").toBeLessThanOrEqual(vp.height + 1);
  });

  test("the whole slide fits regardless of viewport aspect ratio", async ({ page }) => {
    // Three representative aspect ratios. A correctly scaled deck keeps the
    // entire fixed canvas (including the bottom footer) inside the viewport at
    // every size. Before the fix only viewports >= 1920x1080 CSS px showed the
    // footer (which is why zooming OUT to 90% "fixed" it in screenshot #2).
    const viewports = [
      { width: 1512, height: 860, label: "laptop full screen (16:~9.4, short)" },
      { width: 1280, height: 800, label: "16:10 laptop" },
      { width: 1100, height: 620, label: "embedded PRC iframe" },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.setContent(htmlForDeck());

      const footer = page.locator('[data-testid="deck-footer"]');
      const box = await footer.boundingBox();
      const footerBottom = (box?.y ?? Infinity) + (box?.height ?? 0);
      const visible = box !== null && footerBottom <= vp.height && box.x >= 0;
      console.log(`${vp.label} (${vp.width}x${vp.height}): footerBottom=${footerBottom} visible=${visible}`);

      expect(
        visible,
        `footer should be fully visible at ${vp.label} (${vp.width}x${vp.height})`,
      ).toBe(true);
    }
  });
});
