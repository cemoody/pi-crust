import { expect, test } from '@playwright/test';

/**
 * Regression: when a session's on-disk transcript stores assistant
 * `content` as an array of typed blocks (`text`, `thinking`, `toolCall`) —
 * the shape every real pirpc / Anthropic-messages session uses — the pi-crust
 * has to fan those blocks out into:
 *
 *   * a Markdown body that contains only the `text` blocks,
 *   * a "thinking" card for any `thinking` block,
 *   * a separate tool row for each `toolCall` block (with the matching
 *     `toolResult` collapsed beneath it).
 *
 * Before PR #102 ("perf: drop session load from ~57s to <1s") all
 * /messages reads went through the pirpc-pi-adapter's
 * contentTextAndThinking() normalization step, which is exactly what does
 * this fan-out. The new tail-read fast path in http-api-server.ts
 * (`readSessionMessagesTail`) reads raw JSONL records and forwards them
 * straight to `toDashboardMessages`, which sets `text: message.content`
 * verbatim. The pi-crust then treats the structured array as if it were a
 * string, JSON.stringifying it into the assistant bubble — the user sees
 * literal `{ "type": "toolCall", "name": "bash", ... }` text and no tool
 * card at all.
 *
 * This spec is the failing reproduction: it loads the seeded
 * `seeded-session-structured-content` session (whose `sessionFile` points
 * at a real JSONL file in the pirpc on-disk format) and asserts the
 * fan-out happens on the initial load — same as it does when the same
 * session is selected after the adapter has been hot.
 */

const SESSION_ID = 'seeded-session-structured-content';

test.describe('structured assistant content on initial session load', () => {
  // Sentinel that the timeline finished mounting for this session: the
  // header for the active session is wired up synchronously from the
  // SessionListItem the sidebar already has, so it appears even when the
  // /messages payload is empty or malformed. Once it's visible we know
  // the timeline region has had a chance to render.
  async function waitForTimelineMounted(page: import('@playwright/test').Page) {
    // Land on the index first so the server-side coldSessionFiles cache
    // is warmed by the listSessions response before the pi-crust fires its
    // first /messages fetch. Without this priming, a deep-link straight
    // to /?session=<id> on a freshly-booted API races the listSessions
    // population and the /messages call can come back "Unknown session";
    // the pi-crust does not retry that error path (PR #109 stopped the SSE-
    // driven refetch loop), so the timeline silently stays empty.
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Structured tool-call session' })).toBeVisible();
    await page.getByRole('link', { name: 'Structured tool-call session' }).click();
    await expect(page.getByRole('heading', { name: 'Structured tool-call session' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Message timeline' })).toBeVisible();
    // Wait for at least one rendered message bubble so the assertions
    // below race against a populated timeline, not an empty one.
    await expect(page.locator('[aria-label="Message timeline"] article').first()).toBeVisible();
  }

  test('renders structured user prompts as plain text, not raw JSON', async ({ page }) => {
    await waitForTimelineMounted(page);

    const userBubble = page.locator('article[aria-label="user message"]').first();
    await expect(userBubble).toContainText('find the slides extension');

    // Regression: previously the user bubble would render the literal
    // string `[ { "type": "text", "text": "find the slides extension" } ]`
    // because toDashboardMessages forwards array content verbatim and
    // the safe-markdown coercion stringifies it.
    await expect(userBubble).not.toContainText('"type": "text"');
    await expect(userBubble).not.toContainText('[ {');
  });

  test('renders toolCall blocks as tool rows, not raw JSON in the assistant bubble', async ({ page }) => {
    await waitForTimelineMounted(page);

    // The toolCall block in the structured assistant turn must surface
    // as a tool card with the matching tool name.
    const toolCard = page.locator('details.tool-card[aria-label="tool bash"]');
    await expect(toolCard).toBeVisible();
    await toolCard.locator('summary').click();
    await expect(toolCard).toContainText('find /home/coder');

    // And it must NOT have leaked into the assistant bubble as JSON.
    // Scope to .markdown-lite so we're checking only the rendered body,
    // not nested controls / metadata that legitimately reference the
    // tool by name.
    const assistantBody = page
      .locator('article[aria-label="assistant message"]')
      .first()
      .locator('.markdown-lite');
    await expect(assistantBody).not.toContainText('"type": "toolCall"');
    await expect(assistantBody).not.toContainText('"name": "bash"');
    await expect(assistantBody).not.toContainText('toolu_seeded_bash_find_slides');
  });

  test('renders thinking content in a thinking card, not inline in the bubble', async ({ page }) => {
    await waitForTimelineMounted(page);

    const thinkingCard = page.locator('details.thinking-block');
    await expect(thinkingCard).toBeVisible();
    await expect(thinkingCard).toContainText(/Let me locate the slides extension/);

    // Thinking content must not also appear inline in the assistant
    // bubble's Markdown body. The thinking <details> is itself a child
    // of the assistant <article>, so we scope to .markdown-lite (the
    // body container) instead of the whole article.
    const assistantBody = page
      .locator('article[aria-label="assistant message"]')
      .first()
      .locator('.markdown-lite');
    await expect(assistantBody).not.toContainText(/Let me locate the slides extension/);

    // The opaque thinkingSignature value must never appear as visible
    // text in the timeline — regression for the "blob leaked into the
    // body" failure mode.
    await expect(page.getByText('sig-fixture-1')).toHaveCount(0);
  });

  test('renders the final assistant Markdown turn (text-only block) intact', async ({ page }) => {
    await waitForTimelineMounted(page);

    // The trailing assistant message has a text-only content array. It
    // must be rendered as Markdown (heading + bold + inline code).
    await expect(page.getByRole('heading', { name: 'Found the extension' })).toBeVisible();
    await expect(page.locator('.markdown-lite strong', { hasText: 'plan' })).toBeVisible();
    await expect(page.locator('.markdown-lite code', { hasText: 'extensions/slides' })).toBeVisible();

    // And the raw block wrappers must not leak through anywhere in the
    // visible timeline.
    const timeline = page.getByRole('region', { name: 'Message timeline' });
    await expect(timeline).not.toContainText('"type": "text"');
    await expect(timeline).not.toContainText('[ { "type":');
  });
});
