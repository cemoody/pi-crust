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
