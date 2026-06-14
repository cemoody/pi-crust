import { expect, test } from "@playwright/test";

// Reproduces two mobile UX bugs in the slides (presentation) extension:
//   1. The full-screen modal toolbar is a single non-wrapping flex row, so on a
//      narrow phone viewport the right-hand actions ("Presentation mode" and the
//      "×" close button) overflow off-screen — the user can't exit. (Stuck.)
//   2. "Presentation mode" shows the React modal nav arrows AND the iframe's own
//      `.deck-controls` arrows at the same time => competing arrows bottom-right.
// Manual mobile viewport (390x844, iPhone-class) on the chromium project so we
// don't need the WebKit system libs in CI.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("mobile: full-screen toolbar overflows and traps the user", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /^Presentation artifact session\b/ }).click();
  await expect(page.locator('[data-testid="artifact-presentation"]')).toBeVisible();

  await page.getByRole("button", { name: "Full screen" }).click();
  await expect(page.locator('[data-testid="artifact-presentation-modal"]')).toBeVisible();

  await page.screenshot({ path: "mobile-screenshots/after-1-toolbar.png", fullPage: false });

  // Measure whether the close button is actually reachable inside the viewport.
  const vp = page.viewportSize()!;
  const closeBox = await page.getByRole("button", { name: "Close presentation" }).boundingBox();
  console.log("viewport.width =", vp.width);
  console.log("close button box =", JSON.stringify(closeBox));
  if (closeBox) {
    const closeRight = closeBox.x + closeBox.width;
    console.log("close button right edge =", closeRight, "viewport width =", vp.width,
      closeRight > vp.width ? "=> OFF-SCREEN (trapped)" : "=> on-screen");
    // FIX assertion: the close button must be fully within the viewport.
    expect(closeRight).toBeLessThanOrEqual(vp.width);
    expect(closeBox.x).toBeGreaterThanOrEqual(0);
  }
  // And it must actually be clickable (this would hang/throw if off-screen).
  await page.getByRole("button", { name: "Close presentation" }).click();
  await expect(page.locator('[data-testid="artifact-presentation-modal"]')).toHaveCount(0);
});

test("mobile: presentation mode shows competing arrow sets", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /^Presentation artifact session\b/ }).click();
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect(page.locator('[data-testid="artifact-presentation-modal"]')).toBeVisible();

  // Enter presentation mode via the segmented Edit|Present switch
  // (requestFullscreen is a no-op / rejects on mobile WebKit, but the React
  // `presenting` state still flips on).
  await page.locator(".presentation-mode-switch button", { hasText: "Present" }).click();
  await page.waitForTimeout(300);

  await page.screenshot({ path: "mobile-screenshots/after-2-presenting.png", fullPage: false });

  // React modal nav (bottom-center) — the single source of nav chrome.
  const modalNav = page.locator(".presentation-modal-presenting .presentation-modal-nav");
  console.log("react modal nav count =", await modalNav.count());

  // Iframe's own bottom-right deck controls should now be SUPPRESSED (embedded).
  const frame = page.frameLocator('[data-testid="artifact-presentation-modal"]');
  const deckBtns = frame.locator("nav.deck-controls button");
  const iframeArrows = await deckBtns.count();
  console.log("iframe deck-controls buttons =", iframeArrows, iframeArrows === 0 ? "=> suppressed (good)" : "=> still competing");
  expect(iframeArrows).toBe(0);
});
