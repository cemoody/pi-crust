import { test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Renders the app at several mobile viewports across the key user-visible states
 * and writes PNGs into `mobile-screenshots/<viewport>/<state>.png`.
 *
 * We deliberately do NOT assert on visual content here — these screenshots are
 * for human / agent review to spot mobile-layout problems.
 */

const VIEWPORTS = [
  { name: 'iphone-se',     width: 375, height: 667 }, // small iOS
  { name: 'iphone-14',     width: 390, height: 844 }, // modern iOS
  { name: 'pixel-7',       width: 412, height: 915 }, // modern Android
  { name: 'galaxy-fold',   width: 344, height: 882 }, // narrow folded
  { name: 'ipad-mini',     width: 768, height: 1024 }, // small tablet
];

const OUT_ROOT = path.resolve('mobile-screenshots');

async function shot(page: Page, vp: { name: string }, name: string) {
  const dir = path.join(OUT_ROOT, vp.name);
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
}

async function selectSeeded(page: Page) {
  await page.getByRole('button', { name: /^Seeded session\b/ }).click();
  await page.getByText('previously sent hello').waitFor();
  // Let the mobile drawer slide-out transition complete before screenshotting.
  await page.waitForTimeout(280);
}

test.beforeAll(async () => {
  // Wipe only the per-viewport screenshot directories, keep FINDINGS.md etc.
  for (const vp of VIEWPORTS) {
    await fs.rm(path.join(OUT_ROOT, vp.name), { recursive: true, force: true });
  }
});

for (const vp of VIEWPORTS) {
  test.describe(`mobile @ ${vp.name} (${vp.width}x${vp.height})`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });

    test('01 session list (cold landing)', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: /^Seeded session\b/ }).waitFor();
      await shot(page, vp, '01-session-list');
    });

    test('02 active session timeline', async ({ page }) => {
      await page.goto('/');
      await selectSeeded(page);
      await shot(page, vp, '02-active-session');
    });

    test('03 composer focused (keyboard would be open)', async ({ page }) => {
      await page.goto('/');
      await selectSeeded(page);
      await page.getByLabel('Prompt draft').focus();
      await page.getByLabel('Prompt draft').fill('typing a long-ish prompt that wraps a couple of lines on a phone');
      await shot(page, vp, '03-composer-focused');
    });

    test('04 sidebar collapsed', async ({ page }) => {
      await page.goto('/');
      await selectSeeded(page);
      const collapse = page.getByRole('button', { name: /Collapse sidebar/ });
      if (await collapse.isVisible().catch(() => false)) {
        await collapse.click();
      }
      await shot(page, vp, '04-sidebar-collapsed');
    });

    test('05 new session dialog', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'New session' }).click();
      await page.getByRole('dialog', { name: 'Create new session' }).waitFor();
      await shot(page, vp, '05-new-session-dialog');
    });

    test('06 model picker', async ({ page }) => {
      await page.goto('/');
      await selectSeeded(page);
      await page.getByLabel('Prompt draft').fill('/model');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.getByRole('dialog', { name: 'Choose a model' }).waitFor();
      await shot(page, vp, '06-model-picker');
    });

    test('07 fork dialog', async ({ page }) => {
      await page.goto('/');
      await selectSeeded(page);
      await page.getByRole('button', { name: 'Fork', exact: true }).click();
      await page.getByRole('dialog', { name: 'Fork session' }).waitFor();
      await shot(page, vp, '07-fork-dialog');
    });

    test('08 shortcut help', async ({ page }) => {
      await page.goto('/');
      await selectSeeded(page);
      await page.locator('body').press('Shift+?');
      await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
      await shot(page, vp, '08-shortcut-help');
    });

    test('09 after sending a message', async ({ page }) => {
      await page.goto('/');
      await selectSeeded(page);
      await page.getByLabel('Prompt draft').fill('hello from mobile');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.getByText('Mock response to: hello from mobile').first().waitFor();
      await shot(page, vp, '09-after-send');
    });

    test('10 status bar visible', async ({ page }) => {
      await page.goto('/');
      await selectSeeded(page);
      // Scroll the timeline to the bottom so we see the status bar + composer + last reply
      await page.evaluate(() => {
        const el = document.querySelector('.message-timeline, [role="log"], main');
        if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
      });
      await shot(page, vp, '10-status-bar');
    });
  });
}
