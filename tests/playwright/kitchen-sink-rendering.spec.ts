import { expect, test } from '@playwright/test';

/**
 * Generic-surface regression: every renderable shape the WUI knows about
 * should render via its dedicated component, never as raw JSON / a
 * stringified object / an "Unknown artifact" fallback. Driven from the
 * `seeded-session-kitchen-sink` fixture (scripts/seed-mock-session.mjs)
 * which packs every common shape into a single transcript:
 *
 *   1. User text + assistant text (sanity)
 *   2. Assistant markdown — heading, list, *italic*, **bold**, inline
 *      `code`, fenced code block, link
 *   3. Thinking block (assistant `content: [{ type: 'thinking', ... }]`)
 *   4. Tool call + matching tool result (renders as tool-card "bash")
 *   5. Multi-MIME pi-artifact: text/markdown + image/png + text/html
 *   6. Vega-lite artifact (text/vnd.vega-lite.v5+json)
 *
 * The motivation is the same as page-not-blank: one fixture, one spec,
 * data-driven coverage. Adding a renderer to MessageTimeline should grow
 * the seed plus one assertion here, not a new spec file.
 */

const SESSION_LABEL = /^Kitchen sink session\b/;

async function openSession(page: import('@playwright/test').Page) {
  // Land on the index first so the listSessions cache is warm before we
  // ask for /messages — same pattern as structured-content-tool-calls.
  await page.goto('/');
  await expect(page.getByRole('link', { name: SESSION_LABEL })).toBeVisible();
  await page.getByRole('link', { name: SESSION_LABEL }).click();
  await expect(page.getByRole('heading', { name: 'Kitchen sink session' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Message timeline' })).toBeVisible();
  // Wait for at least one bubble so we're not racing an empty timeline.
  await expect(page.locator('[aria-label="Message timeline"] article').first()).toBeVisible();
}

test.describe('kitchen-sink: every renderer renders as structured UI, not raw JSON', () => {
  test('user + assistant text bubbles render as plain prose, not JSON arrays', async ({ page }) => {
    await openSession(page);

    const userBubble = page.locator('article[aria-label="user message"]').first();
    await expect(userBubble).toContainText('render everything you know how to render');
    // The first user message is delivered as a plain string, so it
    // should never contain bracket noise.
    await expect(userBubble).not.toContainText('"type": "text"');

    // Trailing assistant text after the artifact stack.
    await expect(
      page.locator('article[aria-label="assistant message"]', { hasText: 'All shapes emitted' }),
    ).toBeVisible();
  });

  test('assistant markdown renders heading, list, code block, and inline code', async ({ page }) => {
    await openSession(page);

    await expect(page.getByRole('heading', { name: 'Rendering checklist' })).toBeVisible();
    await expect(page.locator('.markdown-lite strong', { hasText: 'bold step' })).toBeVisible();
    await expect(page.locator('.markdown-lite em', { hasText: 'italic' })).toBeVisible();
    await expect(page.locator('.markdown-lite code', { hasText: 'inline code' })).toBeVisible();
    await expect(page.locator('.markdown-lite ul li').first()).toBeVisible();
    await expect(page.locator('.code-block').first()).toContainText('const answer = 42;');
    // Link rendered as <a>, not bare text.
    await expect(page.locator('.markdown-lite a', { hasText: 'a link' })).toHaveAttribute('href', 'https://example.com');
  });

  test('thinking block renders as a thinking tool-card, not inline JSON in the bubble', async ({ page }) => {
    await openSession(page);

    const thinking = page.locator('details.tool-card.thinking[aria-label="thinking step"]');
    await expect(thinking).toBeVisible();
    await thinking.locator('summary').click();
    await expect(thinking).toContainText('I should narrate every renderer');

    // No JSON noise leaked into the assistant bubble.
    const assistantBubbles = page.locator('article[aria-label="assistant message"]');
    await expect(assistantBubbles.first()).not.toContainText('"type": "thinking"');
    await expect(assistantBubbles.first()).not.toContainText('thinkingSignature');
  });

  test('toolCall block renders as a tool-card with the command in the summary', async ({ page }) => {
    await openSession(page);

    const toolCard = page.locator('details.tool-card[aria-label="tool bash"]');
    await expect(toolCard).toBeVisible();
    // Summary surfaces the command (the WUI special-cases bash → args.command).
    await expect(toolCard).toContainText('echo "kitchen sink"');

    // Expanding the card shows the captured output.
    await toolCard.locator('summary').click();
    await expect(toolCard).toContainText('kitchen sink');

    // The toolCall block should never have been left in the assistant
    // bubble as raw JSON.
    await expect(
      page.locator('article[aria-label="assistant message"]', { hasText: '"type": "toolCall"' }),
    ).toHaveCount(0);
  });

  test('multi-MIME pi-artifact picks the first recognized representation (markdown), not the fallback', async ({ page }) => {
    await openSession(page);

    // pickRenderableRepresentation walks the reps in order and renders
    // the first match — for our fixture that's text/markdown.
    const markdownArtifact = page.locator('[data-testid="artifact-markdown"]').first();
    await expect(markdownArtifact).toBeVisible();
    await expect(markdownArtifact.getByRole('heading', { name: 'Markdown rep' })).toBeVisible();
    await expect(markdownArtifact.locator('strong', { hasText: 'markdown' })).toBeVisible();

    // The plain-text "Unknown mime" fallback must not have been rendered
    // for this group.
    await expect(page.locator('[data-testid="artifact-fallback"]')).toHaveCount(0);
  });

  test('vega-lite artifact mounts a chart container (data-testid="artifact-vega-lite")', async ({ page }) => {
    await openSession(page);

    const vega = page.locator('[data-testid="artifact-vega-lite"]');
    await expect(vega).toBeVisible();
    // The fixture's spec is round-tripped onto the figure as data-spec
    // so we can assert no raw JSON leaked into the bubble *and* the
    // chart container picked up the right spec.
    const specAttr = await vega.getAttribute('data-spec');
    expect(specAttr ?? '').toContain('"mark":"bar"');
    expect(specAttr ?? '').toContain('"category":"A"');

    // Regression guard: when the LazyVegaLiteChart path is broken the
    // artifact falls all the way through to ArtifactPlainFallback which
    // pretty-prints the spec into the DOM. If we ever see that string
    // in the timeline, the renderer regressed.
    await expect(page.getByText('"$schema": "https://vega.github.io/schema/vega-lite/v5.json"')).toHaveCount(0);
  });

  test('no representation falls through to the raw "Unknown" plain-text fallback', async ({ page }) => {
    await openSession(page);

    // This is the catch-all guard: if any artifact ever started
    // rendering as the {kind, mime, ...} JSON dump, the data-testid
    // below appears in the DOM. Coverage for "we shipped a new artifact
    // kind without a renderer".
    await expect(page.locator('[data-testid="artifact-fallback"]')).toHaveCount(0);
  });

  test('no react-markdown / unexpected-children pageerror escaped during render', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await openSession(page);
    // Settle: give any lazy chunk (vega) a moment to mount.
    await page.waitForTimeout(250);

    const offending = pageErrors.filter((err) =>
      /react-markdown|Unexpected value.*for `children`/i.test(err.message),
    );
    expect(offending, offending.map((e) => e.message).join('\n')).toHaveLength(0);
  });
});
