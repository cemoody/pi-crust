import { expect, test } from '@playwright/test';

/**
 * Acceptance criteria for generic extension UI chrome:
 * - setStatus requests render as compact, theme-aware chips rather than heavy pills.
 * - setWidget requests render as reusable disclosure cards, not dashed debug boxes.
 * - long extension text is contained and cannot create page-level horizontal overflow.
 * - extension chrome aligns to the same centered content column as the timeline/composer.
 * - mobile defaults keep verbose widget bodies collapsed until the user expands them.
 */

async function openExtensionUiSession(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('a[href="?session=seeded-session-extension-ui"]').first()).toBeVisible();
  await page.locator('a[href="?session=seeded-session-extension-ui"]').first().click();
  await expect(page.getByRole('region', { name: 'Active session' }).getByRole('heading', { name: /^Extension UI generic session/ })).toBeVisible();
  await expect(page.getByLabel('Prompt draft')).toBeVisible();
}

async function triggerExtensionUi(page: import('@playwright/test').Page) {
  const host = page.getByRole('region', { name: 'Extension UI' });
  await page.waitForResponse((response) => response.url().includes('/api/sessions/seeded-session-extension-ui/events'), { timeout: 10_000 }).catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt++) {
    // Let the session event stream attach before emitting one-shot extension UI
    // events; otherwise the prompt can race the initial SSE subscription.
    await page.waitForTimeout(750);
    await page.getByLabel('Prompt draft').fill('@@extension-ui');
    await page.getByRole('button', { name: 'Send' }).click();
    try {
      await expect(host).toBeVisible({ timeout: 1500 });
      return;
    } catch {
      // Retry: the directive is idempotent and upserts status/widget requests.
    }
  }
  await expect(host).toBeVisible();
}

test.describe('generic extension UI', () => {
  test('renders extension statuses and widgets as compact, non-overflowing chrome on desktop', async ({ page }) => {
    await openExtensionUiSession(page);
    await triggerExtensionUi(page);

    const host = page.getByRole('region', { name: 'Extension UI' });
    await expect(host).toBeVisible();

    const statusTray = page.getByRole('region', { name: 'Extension statuses' });
    await expect(statusTray).toBeVisible();
    await expect(statusTray.getByText('⟳ loop · 1 active')).toBeVisible();
    await expect(statusTray.getByText('review · waiting')).toBeVisible();

    const loopWidget = page.getByRole('group', { name: 'Widget loop' });
    await expect(loopWidget).toBeVisible();
    await expect(loopWidget.getByRole('button', { name: /loop extension widget/i })).toBeVisible();
    await expect(loopWidget.locator('.extension-widget-preview')).toContainText(/PROMPT_roofing_dma_pipeline_orchestrator\.md/);

    const auditWidget = page.getByRole('group', { name: 'Widget audit' });
    await expect(auditWidget.getByRole('button', { name: /audit extension widget/i })).toBeVisible();
    await expect(auditWidget.getByText('3 items')).toBeVisible();

    // Generic widgets should be polished cards, not the old dashed debug box.
    await expect(loopWidget).not.toHaveCSS('border-top-style', 'dashed');

    // Long extension text should be contained by the viewport instead of making
    // the whole page horizontally scrollable.
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

    // The visible extension card should sit in the same centered column as the
    // composer, rather than spanning edge-to-edge and visually sticking out past messages.
    const boxes = await page.evaluate(() => {
      const ext = document.querySelector('.extension-widget')?.getBoundingClientRect();
      const composer = document.querySelector('.composer-input')?.getBoundingClientRect();
      if (!ext || !composer) return null;
      return { extLeft: ext.left, extRight: ext.right, composerLeft: composer.left, composerRight: composer.right };
    });
    expect(boxes).not.toBeNull();
    expect(Math.abs(boxes!.extLeft - boxes!.composerLeft)).toBeLessThanOrEqual(4);
    expect(Math.abs(boxes!.extRight - boxes!.composerRight)).toBeLessThanOrEqual(4);

    await page.screenshot({ path: 'test-results/extension-ui-generic-desktop.png', fullPage: true });
  });

  test('collapses verbose widgets by default on mobile and expands on tap', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openExtensionUiSession(page);
    await triggerExtensionUi(page);

    const loopWidget = page.getByRole('group', { name: 'Widget loop' });
    const toggle = loopWidget.getByRole('button', { name: /loop extension widget/i });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(loopWidget.locator('.extension-widget-body')).toBeHidden();
    await expect(loopWidget.locator('.extension-widget-preview')).toContainText(/Read \/home\/coder/);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(loopWidget.locator('.extension-widget-body').getByText(/PROMPT_roofing_dma_pipeline_orchestrator\.md/)).toBeVisible();

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

    const boxes = await page.evaluate(() => {
      const ext = document.querySelector('.extension-widget')?.getBoundingClientRect();
      const composer = document.querySelector('.composer-input')?.getBoundingClientRect();
      if (!ext || !composer) return null;
      return { extLeft: ext.left, extRight: ext.right, composerLeft: composer.left, composerRight: composer.right };
    });
    expect(boxes).not.toBeNull();
    expect(Math.abs(boxes!.extLeft - boxes!.composerLeft)).toBeLessThanOrEqual(4);
    expect(Math.abs(boxes!.extRight - boxes!.composerRight)).toBeLessThanOrEqual(4);

    await page.screenshot({ path: 'test-results/extension-ui-generic-mobile.png', fullPage: true });
  });
});
