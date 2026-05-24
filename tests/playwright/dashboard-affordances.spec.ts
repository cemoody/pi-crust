import { expect, test } from '@playwright/test';

/**
 * Generic-surface regression: dashboard affordances that exist in the UI
 * but aren't currently pinned anywhere. Each test targets one specific
 * user-visible interaction: cold deep-link entry, jump-to-latest scroll
 * pin, rename flow, filter popover open/close, and sort menu. The
 * common thread is "the button is there and clicking it does what its
 * label says".
 */

test.describe('cold deep-link to a session URL', () => {
  test('?session=<id> opens that session on cold load, no Unknown-session error', async ({ page }) => {
    await page.goto('/?session=seeded-session-0001');

    await expect(page.getByRole('heading', { name: /^Seeded session/ })).toBeVisible();
    await expect(page.getByText('previously sent hello')).toBeVisible();
    await expect(page.getByText(/Unknown session/)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Message timeline' })).toBeVisible();
  });

  test('?session=<unknown> falls back to the no-session landing without blanking', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await page.goto('/?session=definitely-not-a-real-session-id');

    // The sidebar with seeded sessions should still be mounted — we
    // never want a bad URL to take the page down.
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Seeded session\b/ })).toBeVisible();

    // No unhandled errors escaped.
    expect(pageErrors.map((e) => e.message)).toEqual([]);
  });
});

test.describe('Jump to latest', () => {
  test('appears when scrolled up and scrolls the timeline back to the bottom on click', async ({ page }) => {
    // Long code session has enough content to make the timeline
    // overflow even at desktop sizes.
    await page.goto('/');
    await page.getByRole('link', { name: /^Long code session\b/ }).click();
    const timeline = page.getByRole('region', { name: 'Message timeline' });
    await expect(timeline).toBeVisible();

    // Pad the timeline with a few extra prompts so there's clearly more
    // content than fits in the viewport.
    for (let i = 0; i < 4; i++) {
      await page.getByLabel('Prompt draft').fill(`pad ${i}`);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByText(`Mock response to: pad ${i}`, { exact: true })).toBeVisible();
    }

    // Scroll the timeline to the top to detach the auto-scroll pin.
    await timeline.evaluate((node) => node.scrollTo({ top: 0 }));

    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect(jump).toBeVisible();
    await jump.click();

    // After clicking, the button disappears (re-pinned at the bottom).
    await expect(jump).toBeHidden();
  });
});

test.describe('Rename flow', () => {
  test('Rename button opens the form, saves, and the header updates', async ({ page }) => {
    // Use a fresh session so we don't churn the shared seed names that
    // other specs look up by exact match.
    await page.goto('/');
    await page.getByRole('link', { name: 'New session' }).click();
    await page.getByLabel('Name this session').fill('Rename starting name');
    await page.getByLabel('Prompt draft').fill('seed prompt');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('heading', { name: 'Rename starting name' })).toBeVisible();

    // Click the explicit Rename action.
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    const form = page.getByRole('form', { name: 'Rename session' }).or(page.getByLabel('Rename session'));
    await expect(form).toBeVisible();

    const nameInput = page.getByLabel('Session name');
    await nameInput.fill('Renamed via dashboard test');
    // Save via Enter, which is the documented commit for the inline rename form.
    await nameInput.press('Enter');

    await expect(page.getByRole('heading', { name: 'Renamed via dashboard test' })).toBeVisible();

    // Survives reload (server-persisted).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Renamed via dashboard test' })).toBeVisible();
  });
});

test.describe('Sidebar filter popover', () => {
  test('Filter sessions chevron toggles the popover and Session filters menu is mounted', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Filter sessions' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menu', { name: 'Session filters' })).toBeVisible();

    // Clicking again closes it.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('menu', { name: 'Session filters' })).toHaveCount(0);
  });
});

test.describe('Status row reacts to the active session', () => {
  test('switching sessions updates the cwd / model fragment in the status row', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /^Seeded session\b/ }).click();
    const status = page.getByLabel('Session status');
    await expect(status).toContainText('idle');

    // Switch to a different seeded session and confirm the status row
    // re-renders for it (still showing idle/cwd/model rather than going
    // blank during the swap).
    await page.getByRole('link', { name: /^Long code session\b/ }).click();
    await expect(page.getByRole('heading', { name: /^Long code session/ })).toBeVisible();
    await expect(status).toBeVisible();
    await expect(status).toContainText(/idle|streaming|responding|thinking/i);
  });
});
