import { expect, test, type Page } from '@playwright/test';

async function selectHugePromptSession(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /^Huge prompt session\b/ }).click();
  // The user bubble is the first message card; wait for it to render.
  await page.locator('.message-card.user').first().waitFor();
  await page.waitForTimeout(200);
}

test.describe('huge user prompt layout', () => {
  test('caps the height of an enormous user message bubble', async ({ page }) => {
    await selectHugePromptSession(page);

    const viewport = page.viewportSize();
    const viewportHeight = viewport?.height ?? 720;

    const bubble = page.locator('.message-card.user').first();
    const metrics = await bubble.evaluate((node) => {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        renderedHeight: Math.round(rect.height),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowY: style.overflowY,
      };
    });

    // The content is far taller than any reasonable viewport...
    expect(metrics.scrollHeight).toBeGreaterThan(viewportHeight);

    // ...but the rendered bubble must NOT take over the whole screen. Cap it to
    // a fraction of the viewport so the rest of the timeline stays reachable.
    expect(metrics.renderedHeight).toBeLessThanOrEqual(Math.round(viewportHeight * 0.75));

    // And the overflowing content must be scrollable inside the bubble rather
    // than pushing everything else off-screen.
    expect(['auto', 'scroll']).toContain(metrics.overflowY);
  });
});
