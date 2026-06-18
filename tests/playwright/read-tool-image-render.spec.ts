import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Feature: the read tool's result can carry an image block (it does whenever
 * the agent reads a PNG/JPEG/…). The timeline should render the ACTUAL image
 * inline when the tool card is expanded — not just the "[Read image file …]"
 * text note + path. Markdown reads should render as formatted markdown.
 *
 * The seeded `seeded-read-image` session is a real on-disk pirpc `.jsonl`
 * transcript, so this exercises the production read path:
 *   readSessionMessagesTail -> toSessionMessages (lifts image blocks onto
 *   tool.images) -> toDashboardMessages (strips bytes to an /images/N URL)
 *   -> MessageTimeline ToolResultBody (renders the <img>).
 */

const SESSION_NAME = 'Read image render demo';
const SHOTS = path.resolve('test-results/read-tool-image');

test.beforeAll(() => {
  fs.mkdirSync(SHOTS, { recursive: true });
});

async function openSession(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByRole('link', { name: SESSION_NAME })).toBeVisible();
  await page.getByRole('link', { name: SESSION_NAME }).click();
  await expect(page.getByRole('heading', { name: SESSION_NAME })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Message timeline' })).toBeVisible();
  await expect(page.locator('[aria-label="Message timeline"] article').first()).toBeVisible();
}

test('read of a PNG renders the image inline when the tool card is expanded', async ({ page }) => {
  await openSession(page);

  const readCard = page.locator('details.tool-card[aria-label="tool read"]').first();
  await expect(readCard).toBeVisible();

  // Collapsed state: the image is hidden inside the (closed) <details>.
  await page.screenshot({ path: path.join(SHOTS, '01-collapsed.png'), fullPage: true });

  // Expand the read tool card.
  await readCard.locator('summary').click();
  await expect(readCard).toHaveJSProperty('open', true);

  // The actual image renders (not just the text note).
  const img = readCard.locator('figure.tool-image img');
  await expect(img).toBeVisible();
  // The image bytes actually load (naturalWidth > 0 means the <img> decoded).
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(100);

  // The "[Read image file …]" note is still shown as context.
  await expect(readCard).toContainText('Read image file [image/png]');

  await img.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, '02-expanded-image.png'), fullPage: true });
  // Tight crop of just the expanded read card.
  await readCard.screenshot({ path: path.join(SHOTS, '03-card-only.png') });
});

test('read of a markdown file renders formatted markdown', async ({ page }) => {
  await openSession(page);

  const mdCard = page.locator('details.tool-card[aria-label="tool read"]').nth(1);
  await expect(mdCard).toBeVisible();
  await mdCard.locator('summary').click();
  await expect(mdCard).toHaveJSProperty('open', true);

  const md = mdCard.locator('.tool-read-markdown');
  await expect(md).toBeVisible();
  await expect(md.locator('h1')).toHaveText('Weekly report');
  await expect(md.locator('strong', { hasText: 'Desktop' })).toBeVisible();
  await expect(md.locator('code', { hasText: 'metrics.csv' })).toBeVisible();

  await mdCard.scrollIntoViewIfNeeded();
  await mdCard.screenshot({ path: path.join(SHOTS, '04-markdown-card.png') });
});
