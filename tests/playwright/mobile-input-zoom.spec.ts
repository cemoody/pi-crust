import { expect, test } from '@playwright/test';

/**
 * iOS Safari auto-zooms when a user focuses an <input> or <textarea> whose
 * computed font-size is < 16px. The zoom doesn't reflow the page, so the
 * right edge of the layout gets clipped (visible as the action icons + send
 * button being cut off in the user's bug report).
 *
 * Playwright's bundled WebKit on Linux doesn't replicate UIKit's zoom
 * behavior, so we can't observe the visual zoom directly. Instead we assert
 * the deterministic precondition: every focusable text control in the
 * mobile layout has computed font-size >= 16px. This fails today on the
 * prompt textarea (13.5px) and passes after the fix.
 */

const MOBILE = { width: 390, height: 844 }; // iPhone 14

test.use({
  viewport: MOBILE,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});

test('prompt textarea has font-size >= 16px on mobile (prevents iOS Safari focus-zoom)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  const textarea = page.getByLabel('Prompt draft');
  await expect(textarea).toBeVisible();

  const fontPx = await textarea.evaluate((el) => parseFloat(getComputedStyle(el as HTMLElement).fontSize));
  expect(fontPx, `prompt textarea font-size is ${fontPx}px; iOS Safari will auto-zoom on focus when <16px`).toBeGreaterThanOrEqual(16);
});

test('Inline new-session name input has font-size >= 16px on mobile', async ({ page }) => {
  await page.goto('/');
  // The 'New session' menu item lives in the sidebar; ensure the sidebar
  // drawer is open before clicking it. The click immediately spawns a
  // session (no modal) and renders the inline 'name this session' input
  // above the composer — that's the input we check for focus-zoom safety.
  await page.getByRole('link', { name: /^Seeded session\b/ }).waitFor();
  await page.getByRole('link', { name: 'New session' }).click();

  const input = page.getByLabel('Name this session');
  await input.waitFor();
  const fontPx = await input.evaluate((el) => parseFloat(getComputedStyle(el as HTMLElement).fontSize));
  expect(fontPx, `Name this session font-size is ${fontPx}px; iOS Safari will auto-zoom on focus when <16px`).toBeGreaterThanOrEqual(16);
});

test('all focusable text inputs in the mobile layout have font-size >= 16px', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  // Collect every input/textarea currently rendered and their computed font-size.
  const offenders = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('input, textarea')) as HTMLElement[];
    return nodes
      .filter((el) => {
        if (el instanceof HTMLInputElement) {
          // Skip non-text types that don't trigger iOS focus-zoom.
          const skip = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button', 'reset', 'hidden']);
          return !skip.has(el.type);
        }
        return true;
      })
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        label: el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? '(no label)',
        fontPx: parseFloat(getComputedStyle(el).fontSize),
      }))
      .filter((row) => row.fontPx < 16);
  });

  expect(offenders, `mobile-zoom-triggering controls: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
});
