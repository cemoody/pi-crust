import { expect, test } from '@playwright/test';

/**
 * Regression test for the long-session pagination fix.
 *
 * Background: opening a session with >INITIAL_MESSAGES_LIMIT (=200) messages
 * used to only ever render the tail. SessionDashboard's mount-time fetch
 * was bounded to the most recent 200 messages, and although the HTTP API
 * and session-api client both supported a `before:` cursor, no UI code
 * path used it. Scrolling to the top therefore exposed the oldest *fetched*
 * message, never the oldest message in the file.
 *
 * Fix: MessageTimeline now fires `onLoadOlder` when the user scrolls near
 * the top, SessionDashboard pages older history in via
 * api.getMessages({ before: oldestLoadedTimestamp }), and the timeline
 * preserves the user's visual scroll position across the prepend.
 *
 * The seeded fixture has 1000 messages. The first message has sentinel
 * "FIRST-MESSAGE-MARKER-α", the last has "LAST-MESSAGE-MARKER-ω".
 */
test('long session: scrolling up loads earlier messages until the first message is reachable', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: /^Long pagination session\b/ }).click();

  // Tail rendered fine.
  await expect(page.getByText(/LAST-MESSAGE-MARKER-ω/)).toBeVisible();

  const timeline = page.locator('.message-timeline');
  await expect(timeline).toBeVisible();

  // Drive successive top-edge loads. We re-scroll to the top after every
  // page resolves; the timeline's scroll-restoration nudges us back down
  // once the prepend lands, so this loop is what keeps pagination
  // marching backwards through the transcript. Bail as soon as the first
  // marker is in the DOM.
  const firstMarker = page.getByText(/FIRST-MESSAGE-MARKER-α/);
  for (let attempt = 0; attempt < 25; attempt++) {
    if (await firstMarker.count() > 0) break;
    await timeline.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
  }

  const renderedRowCount = await page.locator('.message-timeline-inner article.message-card').count();
  console.log(`rendered timeline article cards: ${renderedRowCount}`);

  // --- Headline regression assertion ---------------------------------------
  // With pagination wired up, scrolling to the top until exhaustion should
  // make the very first seeded message reachable.
  await expect(
    firstMarker.first(),
    'scrolling up should eventually reveal the first message via on-demand pagination'
  ).toBeVisible({ timeout: 5_000 });
});

/**
 * On mount, only the most recent INITIAL_MESSAGES_LIMIT messages are
 * fetched — the rest stream in only as the user scrolls. Before any
 * scrolling we should see the tail marker but NOT the first marker, and
 * the timeline should advertise that more history is available via the
 * older-loader affordance.
 */
test('long session: initial render is the tail only and exposes a load-older affordance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Long pagination session\b/ }).click();

  await expect(page.getByText(/LAST-MESSAGE-MARKER-ω/)).toBeVisible();
  // First marker is NOT in the DOM yet — it lives ~800 messages older than
  // the 200-message initial window.
  await expect(page.getByText(/FIRST-MESSAGE-MARKER-α/)).toHaveCount(0);
  // Older-loader affordance is present, signalling pagination is wired up.
  await expect(page.getByTestId('timeline-older-loader')).toBeAttached();
});
