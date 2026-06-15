import { expect, test } from '@playwright/test';

/**
 * End-to-end regression for the long *tool-heavy* session pagination bug
 * (the "I can't scroll all the way back to my first prompt" report on
 * session 019ea8e9).
 *
 * The seeded fixture (scripts/seed-mock-session.mjs → "Long tool-call
 * session") is a real on-disk pirpc/Anthropic `.jsonl` transcript of ~160
 * tool-call-only turns, padded to ~1.5MB so it spans many 64KB tail-read
 * chunks. Under the toSessionMessages() fan-out, each tool-call-only
 * assistant turn + separate `role:"toolResult"` record collapses to a
 * single tool row, so a 200-RAW tail window normalizes to only ~138
 * messages.
 *
 * The bug: SessionDashboard's initial fetch asked for the most recent 200
 * messages and armed the scroll-up "load older" affordance only when
 * `messages.length >= 200`. Because the tail window shrank below 200, the
 * client concluded the transcript was complete and disabled pagination —
 * the first message (FIRST-MESSAGE-MARKER-α) was unreachable no matter how
 * far you scrolled.
 *
 * The fix makes /messages?limit=N return a full page of N *normalized*
 * messages whenever the transcript is longer than N, so the affordance
 * arms and scroll-up pagination walks back to the very first message.
 */
test('long tool-heavy session: scrolling up loads earlier messages until the first message is reachable', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: /^Long tool-call session\b/ }).click();

  // Tail rendered: the final assistant bubble is visible.
  await expect(page.getByText(/LAST-MESSAGE-MARKER-ω/)).toBeVisible();

  const timeline = page.locator('.message-timeline');
  await expect(timeline).toBeVisible();

  // The load-older affordance MUST be armed even though the initial tail
  // window normalized to fewer than 200 messages. This is the crux of the
  // regression: pre-fix it was absent and pagination never fired.
  await expect(page.getByTestId('timeline-older-loader')).toBeAttached();

  // Drive successive top-edge loads until the first message lands.
  const firstMarker = page.getByText(/FIRST-MESSAGE-MARKER-α/);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await firstMarker.count() > 0) break;
    await timeline.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
  }

  await expect(
    firstMarker.first(),
    'scrolling up should eventually reveal the first message of a long tool-heavy session'
  ).toBeVisible({ timeout: 5_000 });
});

/**
 * On mount only the tail is fetched, but because this is a tool-heavy
 * transcript the tail window normalizes below INITIAL_MESSAGES_LIMIT. The
 * first marker must NOT be present yet, and the older-loader affordance
 * must still be attached (the bug was that it wasn't, stranding the user).
 */
test('long tool-heavy session: initial render is the tail and still exposes a load-older affordance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Long tool-call session\b/ }).click();

  await expect(page.getByText(/LAST-MESSAGE-MARKER-ω/)).toBeVisible();
  await expect(page.getByText(/FIRST-MESSAGE-MARKER-α/)).toHaveCount(0);
  await expect(page.getByTestId('timeline-older-loader')).toBeAttached();
});
