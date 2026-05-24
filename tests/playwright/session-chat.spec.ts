import { expect, test } from '@playwright/test';

test('can select a listed cold session and send hello without unknown-session error', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('link', { name: /^Seeded session\b/ })).toBeVisible();
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  await page.getByLabel('Prompt draft').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();

  // exact: true so this doesn't strict-mode-collide with the
  // "Mock response to: hello from mobile" replies the mobile-screenshots
  // suite leaves in the shared mock seed when both specs run in the same
  // playwright invocation.
  await expect(page.getByText('Mock response to: hello', { exact: true })).toBeVisible();
  await expect(page.getByText(/Unknown session/)).toHaveCount(0);
});

test('shows existing session history and renders markdown when a session is selected', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  await expect(page.getByText('previously sent hello')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(page.locator('.markdown-lite strong', { hasText: 'bold step' })).toBeVisible();
  await expect(page.locator('.markdown-lite em', { hasText: 'italic' })).toBeVisible();
  await expect(page.locator('.markdown-lite code', { hasText: 'inline code' })).toBeVisible();
  await expect(page.locator('.markdown-lite ul li').first()).toBeVisible();
  await expect(page.locator('.code-block')).toContainText('const answer = 42;');
});

test('default copy puts only the last assistant text on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  const footer = page.getByLabel('Turn actions').first();
  await expect(footer).toBeVisible();
  await footer.getByRole('button', { name: 'Copy assistant response' }).click();
  // Copy feedback is surfaced via the unified notification region (see
  // src/web/components/notifications.tsx) instead of the legacy inline
  // `turn-copied` pill that used to live inside the turn footer.
  await expect(page.getByLabel('Notifications').getByText('Copied reply')).toBeVisible();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).not.toMatch(/^\*\*You:/);
  expect(clipboard).not.toContain('previously sent hello');
  expect(clipboard).toContain('## Plan');
});

test('overflow menu can copy the entire turn as markdown', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  const footer = page.getByLabel('Turn actions').first();
  await footer.getByRole('button', { name: 'More copy options' }).click();
  await footer.getByRole('menuitem', { name: /Copy entire turn as markdown/ }).click();
  await expect(page.getByLabel('Notifications').getByText('Copied turn')).toBeVisible();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('**You:**');
  expect(clipboard).toContain('previously sent hello');
  expect(clipboard).toContain('**Assistant:**');
  expect(clipboard).toContain('## Plan');
});

test('preserves the active session in the URL across reloads', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();
  await expect(page).toHaveURL(/[?&]session=seeded-session-0001/);

  await page.reload();
  await expect(page.getByText('previously sent hello')).toBeVisible();
  await expect(page).toHaveURL(/[?&]session=seeded-session-0001/);
});

test('fork button creates a new session with the selected prompt restored', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  await page.getByRole('button', { name: 'Fork', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Fork session' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /previously sent hello/ }).click();

  await expect(page.getByRole('heading', { name: /Fork of Seeded session/ })).toBeVisible();
  await expect(page.getByLabel('Prompt draft')).toHaveValue('previously sent hello');
  await expect(page.getByText(/ready to edit/i)).toBeVisible();
});

test('/fork slash command accepts a fork message index', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  await page.getByLabel('Prompt draft').fill('/fork 1');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('heading', { name: /Fork of Seeded session/ })).toBeVisible();
  await expect(page.getByLabel('Prompt draft')).toHaveValue('previously sent hello');
});

test('/clear slash command starts a fresh session (alias for /new)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  // Confirm we're sitting on the seeded session before /clear.
  await expect(page.getByRole('heading', { name: /^Seeded session/ })).toBeVisible();

  await page.getByLabel('Prompt draft').fill('/clear');
  await page.getByRole('button', { name: 'Send' }).click();

  // The active session swaps to a fresh untitled session, and the /clear
  // text is never delivered to the model.
  await expect(page.getByRole('heading', { name: 'Untitled session' })).toBeVisible();
  await expect(page.getByText(/Mock response to: \/clear/)).toHaveCount(0);
  await expect(page.getByLabel('Prompt draft')).toHaveValue('');
});

test('top-right session actions reflect implemented extension commands', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  await expect(page.getByRole('button', { name: 'Compact', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tree', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clone', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Fork', exact: true })).toBeEnabled();
});

test('opens model picker for /model slash command instead of sending it as a prompt', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

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
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();
  await page.getByLabel('Prompt draft').fill('streaming hello');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('streaming hello').first()).toBeVisible();
  await expect(page.getByText('Mock response to: streaming hello')).toBeVisible();
});

test('pasted image flows end-to-end: user bubble preview, no raw JSON, assistant acknowledges', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();
  const draft = page.getByLabel('Prompt draft');
  await draft.focus();

  // 1x1 transparent PNG
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await page.evaluate(async (b64) => {
    const draftEl = document.querySelector('textarea[aria-label="Prompt draft"]') as HTMLTextAreaElement;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'screenshot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    draftEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pngBase64);

  await expect(page.getByText('screenshot.png')).toBeVisible();
  await draft.fill('What is in the image?');
  await page.getByRole('button', { name: 'Send' }).click();

  // Assistant ack confirms the image actually reached the adapter
  await expect(page.getByText(/Got 1 image attachment/)).toBeVisible();
  await expect(page.getByText(/image\/png/)).toBeVisible();

  // User bubble must NOT show raw JSON content blocks
  await expect(page.getByText(/"type":"image"/)).toHaveCount(0);
  await expect(page.getByText(/"mediaType"/)).toHaveCount(0);
  await expect(page.getByText(/iVBORw0KGgo/)).toHaveCount(0);

  // And the user message should render an image preview (not text)
  await expect(page.locator('.message-card.user img').first()).toBeVisible();
});

test('pasting an image attaches it as an attachment instead of inserting raw text', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();
  const draft = page.getByLabel('Prompt draft');
  await draft.focus();

  // 1x1 transparent PNG
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await page.evaluate(async (b64) => {
    const draftEl = document.querySelector('textarea[aria-label="Prompt draft"]') as HTMLTextAreaElement;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'pasted.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    draftEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pngBase64);

  await expect(draft).toHaveValue('');
  await expect(page.getByText('pasted.png')).toBeVisible();
});

test('real browser clipboard image paste reaches the mock backend', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5174' });
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  const clipboardSupport = await page.evaluate(() => ({
    secure: window.isSecureContext,
    hasClipboardWrite: typeof navigator.clipboard?.write === 'function',
    hasClipboardItem: typeof ClipboardItem !== 'undefined',
  }));
  expect(clipboardSupport).toEqual({ secure: true, hasClipboardWrite: true, hasClipboardItem: true });

  // 1x1 transparent PNG written to the real browser clipboard, then pasted with Ctrl/Cmd+V.
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }, pngBase64);

  const draft = page.getByLabel('Prompt draft');
  await draft.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');

  await expect(draft).toHaveValue('');
  await expect(page.locator('.attachments img')).toBeVisible();
  await expect(page.getByText(/Attached pasted image/i)).toHaveCount(0);

  await draft.fill('real clipboard image e2e');
  const promptRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/prompt'));
  await page.getByRole('button', { name: 'Send' }).click();
  const body = (await promptRequest).postDataJSON() as { text: string; attachments: Array<{ type: string; mimeType: string; data: string }> };
  expect(body.text).toBe('real clipboard image e2e');
  expect(body.attachments).toHaveLength(1);
  const attachment = body.attachments[0]!;
  expect(attachment).toMatchObject({ type: 'image', mimeType: 'image/png' });
  expect(attachment.data).toContain('iVBORw0KGgo');

  await expect(page.getByText(/Mock response to: real clipboard image e2e/)).toBeVisible();
  await expect(page.getByText(/image\/png, 120 chars/)).toBeVisible();
});

test('raw image JSON paste is rejected with a friendly warning', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();
  const draft = page.getByLabel('Prompt draft');
  await draft.focus();

  const fake = `{"type":"image","source":{"type":"base64","mediaType":"image/png","data":"iVBORw0KGgo${'A'.repeat(3000)}"}}`;
  await page.evaluate((payload) => {
    const draftEl = document.querySelector('textarea[aria-label="Prompt draft"]') as HTMLTextAreaElement;
    const dt = new DataTransfer();
    dt.setData('text/plain', payload);
    draftEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, fake);

  await expect(draft).toHaveValue('');
  await expect(page.getByText(/Clipboard looks like raw image data/i)).toBeVisible();
});

test('shows status row beneath composer with cwd, model, and TUI-style stats', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  const status = page.getByLabel('Session status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('idle');
  // Match any plausible cwd substring. CI checkout dir is still 'pi-remote-control'
  // until the GitHub repo itself is renamed; local clones may be 'pi-crust' or a
  // worktree variant.
  await expect(status).toContainText(/pi-crust|pi-remote-control|no-success-paste-warning|delete-session-persistence|trol-/);
  await expect(status).toContainText(/no model selected|mock\/mock\/mock-echo/);
  await expect(status).toContainText('↑0');
  await expect(status).toContainText('↓0');
  await expect(status).toContainText('$0.0000');
  await expect(status).toContainText('200k');
});

test('sidebar collapses without shrinking the main area', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: 'Sessions' });
  const main = page.getByRole('region', { name: 'Active session' });
  await expect(sidebar).toBeVisible();

  const openWidth = await main.evaluate((node) => (node as HTMLElement).getBoundingClientRect().width);

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar).toBeHidden();

  const collapsedWidth = await main.evaluate((node) => (node as HTMLElement).getBoundingClientRect().width);
  expect(collapsedWidth).toBeGreaterThan(openWidth);

  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(sidebar).toBeVisible();
});

test('shortcut modal opens with ? outside an input, ignored inside textarea', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  await page.locator('body').press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();

  await page.getByLabel('Prompt draft').focus();
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  await expect(page.getByLabel('Prompt draft')).toHaveValue('?');
});

test('deleted sessions stay deleted after frontend reload', async ({ page }) => {
  await page.goto('/');

  // Inline 'New session' flow: clicking the menu item immediately spawns
  // a session and focuses the prompt; the optional name is entered in an
  // inline input above the composer, not a modal.
  await page.getByRole('link', { name: 'New session' }).click();
  await page.getByLabel('Name this session').fill('Delete persistence check');
  // The rename commits on blur; tab away from the field to trigger it.
  await page.getByLabel('Name this session').press('Tab');

  await expect(page.getByRole('heading', { name: 'Delete persistence check' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByText('Delete persistence check')).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Delete persistence check')).toHaveCount(0);
});

test('can create a new session and send hello', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: 'New session' }).click();
  // Inline name input → first prompt commits the rename alongside the
  // send, no modal in between.
  await page.getByLabel('Name this session').fill('Playwright new session');
  await page.getByLabel('Prompt draft').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'Playwright new session' })).toBeVisible();

  // exact: true — see note on the cold-session counterpart above.
  await expect(page.getByText('Mock response to: hello', { exact: true })).toBeVisible();
  await expect(page.getByText(/Unknown session/)).toHaveCount(0);
});
