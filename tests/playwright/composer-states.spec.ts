import { expect, test } from '@playwright/test';

/**
 * Generic-surface regression: the prompt composer's three baseline
 * states — empty / has-text / sent — and its keyboard shortcut. These
 * are the kind of things that silently degrade when refactoring the
 * input layout, and they aren't covered elsewhere.
 */

async function openSeeded(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();
  await expect(page.getByRole('heading', { name: /^Seeded session/ })).toBeVisible();
}

test.describe('prompt composer baseline states', () => {
  test('Send button is disabled with an empty draft, enabled with text', async ({ page }) => {
    await openSeeded(page);
    const send = page.getByRole('button', { name: 'Send' });
    const draft = page.getByLabel('Prompt draft');

    await expect(draft).toHaveValue('');
    await expect(send).toBeDisabled();

    await draft.fill('hello');
    await expect(send).toBeEnabled();

    // Clearing again returns to disabled.
    await draft.fill('');
    await expect(send).toBeDisabled();
  });

  test('Cmd/Ctrl+Enter sends the prompt from inside the textarea', async ({ page }) => {
    await openSeeded(page);
    const draft = page.getByLabel('Prompt draft');
    await draft.fill('keyboard-send hello');

    // Both Meta+Enter and Control+Enter are wired to Send; we send
    // the platform-appropriate combo here so the spec matches the
    // shortcut hint shown in the help modal.
    await draft.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');

    await expect(page.getByText('Mock response to: keyboard-send hello', { exact: true })).toBeVisible();
    // Draft is cleared after send.
    await expect(draft).toHaveValue('');
  });

  test('Shift+Enter inserts a newline instead of sending', async ({ page }) => {
    await openSeeded(page);
    const draft = page.getByLabel('Prompt draft');
    await draft.fill('line one');
    await draft.press('Shift+Enter');
    await draft.type('line two');

    await expect(draft).toHaveValue('line one\nline two');
    // Nothing got sent.
    await expect(page.getByText('Mock response to: line one')).toHaveCount(0);
  });

  test('after Send the user message and assistant reply both render in the timeline', async ({ page }) => {
    await openSeeded(page);
    await page.getByLabel('Prompt draft').fill('round-trip ping');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('round-trip ping').first()).toBeVisible();
    await expect(page.getByText('Mock response to: round-trip ping', { exact: true })).toBeVisible();
  });
});
