import { expect, test } from '@playwright/test';

test('can select a listed cold session and send hello without unknown-session error', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: /Seeded session/ })).toBeVisible();
  await page.getByRole('button', { name: /Seeded session/ }).click();

  await page.getByLabel('Prompt draft').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Mock response to: hello')).toBeVisible();
  await expect(page.getByText(/Unknown session/)).toHaveCount(0);
});

test('shows existing session history when a session is selected (before sending)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Seeded session/ }).click();

  await expect(page.getByText('previously sent hello')).toBeVisible();
  await expect(page.getByText('previously stored response')).toBeVisible();
});

test('opens model picker for /model slash command instead of sending it as a prompt', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Seeded session/ }).click();

  await page.getByLabel('Prompt draft').fill('/model');
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.getByRole('dialog', { name: 'Choose a model' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Mock Echo')).toBeVisible();
  await expect(page.getByText(/Mock response to: \/model/)).toHaveCount(0);

  const echoItem = dialog.getByRole('button', { name: /Mock Echo/ });
  await expect(echoItem.locator('strong')).toHaveText('Mock Echo');
  await expect(echoItem.locator('span')).toHaveText('mock/mock-echo');

  const dimensions = await echoItem.evaluate((node) => ({
    height: (node as HTMLElement).getBoundingClientRect().height,
    display: window.getComputedStyle(node).display,
  }));
  expect(dimensions.height).toBeGreaterThan(40);
  expect(dimensions.display).toBe('grid');

  await echoItem.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('mock/mock-echo')).toBeVisible();
});

test('streams the user and assistant messages over SSE during a turn', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Seeded session/ }).click();
  await page.getByLabel('Prompt draft').fill('streaming hello');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('streaming hello').first()).toBeVisible();
  await expect(page.getByText('Mock response to: streaming hello')).toBeVisible();
});

test('shows status row beneath composer with cwd, model, tokens', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Seeded session/ }).click();

  const status = page.getByLabel('Session status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('idle');
  await expect(status).toContainText('pi-remote-control');
  await expect(status).toContainText('no model selected');
});

test('sidebar collapses and expands via the toggle', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: 'Sessions' });
  await expect(sidebar).toBeVisible();

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar).toBeHidden();

  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(sidebar).toBeVisible();
});

test('shortcut modal opens with ? outside an input, ignored inside textarea', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Seeded session/ }).click();

  await page.locator('body').press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();

  await page.getByLabel('Prompt draft').focus();
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  await expect(page.getByLabel('Prompt draft')).toHaveValue('?');
});

test('can create a new session and send hello', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('New session cwd').fill(process.cwd());
  await page.getByLabel('New session name').fill('Playwright new session');
  await page.getByRole('button', { name: 'New session' }).click();

  await expect(page.getByRole('heading', { name: 'Playwright new session' })).toBeVisible();
  await page.getByLabel('Prompt draft').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Mock response to: hello')).toBeVisible();
  await expect(page.getByText(/Unknown session/)).toHaveCount(0);
});
