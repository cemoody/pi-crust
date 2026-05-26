import { expect, test } from '@playwright/test';

test('built single-process pi-crust serves UI and API from the same origin', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toMatchObject({ ok: true, adapter: 'mock' });

  await page.goto('/');
  await expect(page).toHaveTitle(/pi|π|crust/i);
  await expect(page.getByText(/new session/i).first()).toBeVisible();

  const sessions = await request.get('/api/sessions');
  expect(sessions.status()).toBe(200);
  expect(await sessions.json()).toEqual(expect.any(Array));
});
