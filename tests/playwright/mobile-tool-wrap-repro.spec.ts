import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('mobile-screenshots/repro');
const SCREENSHOT = path.join(OUT_DIR, 'tool-wrap-iphone-14.png');

async function selectToolWrapSession(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /^Tool wrap repro session\b/ }).click();
  await page.getByText('new test in a new git work tree').waitFor();
  // Let the mobile drawer slide-out transition complete before measuring or
  // screenshotting the active session.
  await page.waitForTimeout(280);
}

test.describe('mobile tool timeline row layout', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });

  test('keeps tool duration labels single-line on a phone viewport', async ({ page }, testInfo) => {
    await fs.mkdir(OUT_DIR, { recursive: true });
    await selectToolWrapSession(page);

    await page.screenshot({ path: SCREENSHOT, fullPage: false });
    await testInfo.attach('tool-wrap-iphone-14.png', {
      path: SCREENSHOT,
      contentType: 'image/png',
    });

    const wrappedStatuses = await page.locator('.tool-card:not(.thinking) .tool-status-text').evaluateAll((nodes) => {
      return nodes.map((node) => {
        const el = node as HTMLElement;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
        const text = (el.textContent ?? '').trim();
        return {
          text,
          height: Math.round(rect.height * 100) / 100,
          lineHeight: Math.round(lineHeight * 100) / 100,
          wraps: rect.height > lineHeight * 1.45,
          whiteSpace: style.whiteSpace,
        };
      }).filter((status) => status.text.length > 0 && status.wraps);
    });

    await testInfo.attach('wrapped-tool-statuses.json', {
      body: JSON.stringify(wrappedStatuses, null, 2),
      contentType: 'application/json',
    });

    // Regression guard: right-aligned duration labels (for example "5 sec" /
    // "30 ms") must stay on one line. The middle command/preview column should
    // be the only part of the row allowed to truncate on narrow phones.
    expect(wrappedStatuses).toEqual([]);
  });
});
