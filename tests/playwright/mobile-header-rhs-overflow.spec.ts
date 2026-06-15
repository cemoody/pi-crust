import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('mobile-screenshots/repro');
const SCREENSHOT = path.join(OUT_DIR, 'header-rhs-overflow-iphone.png');

async function selectLongTitleSession(page: Page) {
  await page.goto('/');
  await page
    .getByRole('link', { name: /^Prep: Acrisure \+ Vertical Accelerator partner research\b/ })
    .click();
  await page.getByText("He's a").first().waitFor();
  // Let the mobile drawer slide-out transition complete before measuring.
  await page.waitForTimeout(320);
}

test.describe('mobile active-session header layout', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });

  test('a long session title does not push the composer off the right edge', async ({ page }, testInfo) => {
    await fs.mkdir(OUT_DIR, { recursive: true });
    await selectLongTitleSession(page);

    await page.screenshot({ path: SCREENSHOT, fullPage: false });
    await testInfo.attach('header-rhs-overflow-iphone.png', {
      path: SCREENSHOT,
      contentType: 'image/png',
    });

    // The core invariant: the document must not be wider than the visible
    // viewport. When the header's `min-width: auto` lets a long title blow out
    // the grid column, document.scrollWidth grows past the visual viewport and
    // everything to the right — including the composer's send/stop button — is
    // rendered off-screen.
    const layout = await page.evaluate(() => {
      const visual = Math.round(window.visualViewport?.width ?? window.innerWidth);
      const composer = document.querySelector('.prompt-composer');
      const composerRight = composer ? Math.round(composer.getBoundingClientRect().right) : null;
      return {
        visualViewport: visual,
        docScrollWidth: document.documentElement.scrollWidth,
        composerRight,
      };
    });

    await testInfo.attach('layout-metrics.json', {
      body: JSON.stringify(layout, null, 2),
      contentType: 'application/json',
    });

    // No horizontal page overflow (allow 1px for sub-pixel rounding).
    expect(layout.docScrollWidth).toBeLessThanOrEqual(layout.visualViewport + 1);
    // The composer's right edge must stay within the visible viewport.
    expect(layout.composerRight).not.toBeNull();
    expect(layout.composerRight as number).toBeLessThanOrEqual(layout.visualViewport + 1);
  });
});
