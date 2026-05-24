import { expect, test } from '@playwright/test';

/**
 * Generic-surface regression: rarer message shapes the timeline knows
 * how to render but no existing fixture exercises.
 *
 *   - role:"summary", summaryKind:"compaction"  → "Compaction summary"
 *   - role:"summary", summaryKind:"branch"      → "Branch summary"
 *   - assistant with stopReason:"error" + errorMessage → error badge
 *     and scoped <p role="alert"> error treatment
 *
 * Driven from seed `seeded-session-shape-extras`.
 */

async function openExtras(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Message shape extras' })).toBeVisible();
  await page.getByRole('link', { name: 'Message shape extras' }).click();
  await expect(page.getByRole('heading', { name: 'Message shape extras' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Message timeline' })).toBeVisible();
  await expect(page.locator('[aria-label="Message timeline"] article').first()).toBeVisible();
}

test.describe('summary message rendering', () => {
  test('summaryKind:"compaction" renders with a "Compaction summary" header', async ({ page }) => {
    await openExtras(page);

    const compaction = page
      .locator('article[aria-label="summary message"]')
      .filter({ hasText: 'Compaction summary' });
    await expect(compaction).toBeVisible();
    await expect(compaction).toContainText('Conversation was compacted');
  });

  test('summaryKind:"branch" renders with a "Branch summary" header', async ({ page }) => {
    await openExtras(page);

    const branch = page
      .locator('article[aria-label="summary message"]')
      .filter({ hasText: 'Branch summary' });
    await expect(branch).toBeVisible();
    await expect(branch).toContainText('Forked from message');
  });

  test('summary rows carry the .message-card.summary class (distinct treatment from user/assistant)', async ({ page }) => {
    await openExtras(page);

    // Both summary rows exist with the role-specific class.
    await expect(page.locator('article.message-card.summary')).toHaveCount(2);
  });
});

test.describe('assistant error rendering', () => {
  test('errored assistant turn shows an error badge in the header', async ({ page }) => {
    await openExtras(page);

    // The header for the assistant message labels itself "assistant
    // message" — find the one that contains an error badge.
    const erroredCard = page
      .locator('article[aria-label="assistant message"]')
      .filter({ has: page.locator('.badge.error') });
    await expect(erroredCard).toBeVisible();
    await expect(erroredCard.locator('.badge.error')).toHaveText(/error/i);
  });

  test('error message text renders inside the card via <p role="alert">, scoped to the message', async ({ page }) => {
    await openExtras(page);

    const alert = page.getByRole('alert').filter({ hasText: 'simulated upstream error' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('provider returned 500');
  });

  test('the error message does NOT take down the rest of the timeline', async ({ page }) => {
    await openExtras(page);

    // Everything before the errored turn still renders. Composer is
    // still mounted (the user can recover).
    await expect(page.getByText('kick off the long-running flow')).toBeVisible();
    await expect(page.getByText('After compaction, here is what I remember')).toBeVisible();
    await expect(page.getByLabel('Prompt draft')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });
});
