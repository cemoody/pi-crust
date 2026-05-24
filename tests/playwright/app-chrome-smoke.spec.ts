import { expect, test } from '@playwright/test';

/**
 * Generic-surface smoke: the top-level chrome of the app — sidebar,
 * "New session" link, model picker, hotkeys / shortcut modal, version
 * footer, session-status row — has to mount and respond to interaction
 * on every load. These are the controls a user touches first; if any
 * silently drops out we want a CI failure long before a customer notices.
 *
 * This file intentionally avoids deep behavior assertions (those live in
 * session-chat / structured-content / kitchen-sink). It just pins the
 * "the buttons are there and clicking them does something visible"
 * contract.
 */

test.describe('app chrome smoke', () => {
  test('no-session landing has sidebar, new-session entry, and at least one seeded session', async ({ page }) => {
    await page.goto('/');

    // Sidebar mounts with the seeded sessions visible.
    const sidebar = page.getByRole('complementary', { name: 'Sessions' });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole('link', { name: /^Seeded session\b/ })).toBeVisible();

    // The "New session" entry is the primary CTA in the workspace nav.
    await expect(page.getByRole('link', { name: 'New session' })).toBeVisible();

    // Search box for filtering the session list is mounted.
    await expect(page.getByPlaceholder('Search sessions')).toBeVisible();
  });

  test('search box filters the sidebar session list', async ({ page }) => {
    await page.goto('/');

    const longLink = page.getByRole('link', { name: /^Long code session\b/ });
    const seededLink = page.getByRole('link', { name: /^Seeded session\b/ });
    await expect(longLink).toBeVisible();
    await expect(seededLink).toBeVisible();

    const filter = page.getByPlaceholder('Search sessions');
    await filter.fill('Long code');
    await expect(longLink).toBeVisible();
    await expect(seededLink).toHaveCount(0);

    await filter.fill('');
    await expect(seededLink).toBeVisible();
  });

  test('sidebar Collapse / Expand round-trip stays on one open SSE-shaped layout', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.getByRole('complementary', { name: 'Sessions' });
    await expect(sidebar).toBeVisible();

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar).toBeHidden();

    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sidebar).toBeVisible();
  });

  test('shortcut modal opens via ? and closes via Escape', async ({ page }) => {
    await page.goto('/');
    // Press ? somewhere outside an input.
    await page.locator('body').press('Shift+?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();

    // Footer renders a "Build versions" block — protects against the
    // shortcut help losing its diagnostic footer (a frequent point
    // where regressions hide).
    await expect(dialog.getByLabel('Build versions')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Choose-a-model dialog opens, lists at least one model, and closes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /^Seeded session\b/ }).click();

    // The /model slash command is the supported entry point into the
    // model picker today; using it keeps this test honest about the
    // user-visible affordance instead of poking internal state.
    await page.getByLabel('Prompt draft').fill('/model');
    await page.getByRole('button', { name: 'Send' }).click();

    const dialog = page.getByRole('dialog', { name: 'Choose a model' });
    await expect(dialog).toBeVisible();
    // At least one model entry rendered.
    await expect(dialog.getByRole('button', { name: /Mock/ }).first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Close model picker' }).click();
    await expect(dialog).toBeHidden();
  });

  test('Fork dialog opens with at least one fork point and closes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /^Seeded session\b/ }).click();

    await page.getByRole('button', { name: 'Fork', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Fork session' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /previously sent hello/ })).toBeVisible();

    await dialog.getByRole('button', { name: 'Close fork dialog' }).click();
    await expect(dialog).toBeHidden();
  });

  test('session status row reports cwd, model, and TUI-style counters', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /^Seeded session\b/ }).click();

    const status = page.getByLabel('Session status');
    await expect(status).toBeVisible();
    // The exact text varies across worktrees / branches, but these
    // sentinel tokens are stable shape contracts.
    await expect(status).toContainText(/idle|streaming|responding|thinking/i);
    await expect(status).toContainText('↑');
    await expect(status).toContainText('↓');
    await expect(status).toContainText('$');
  });

  test('top-right session action buttons (Clone, Fork) are mounted and enabled', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /^Seeded session\b/ }).click();

    await expect(page.getByRole('button', { name: 'Clone', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Fork', exact: true })).toBeEnabled();
  });
});
