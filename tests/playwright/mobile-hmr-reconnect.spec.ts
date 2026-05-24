import { expect, test, type Page } from '@playwright/test';

const MOBILE = { width: 390, height: 844 }; // iPhone 14-ish
const BOOT_COUNT_KEY = '__pw_mobile_hmr_reconnect_boot_count';
const BEFORE_UNLOAD_KEY = '__pw_mobile_hmr_reconnect_beforeunload_count';

async function installViteHmrSocketProbe(page: Page): Promise<void> {
  await page.addInitScript(({ bootCountKey, beforeUnloadKey }) => {
    const previousBootCount = Number(window.sessionStorage.getItem(bootCountKey) ?? '0');
    window.sessionStorage.setItem(bootCountKey, String(previousBootCount + 1));
    window.addEventListener('beforeunload', () => {
      const previous = Number(window.sessionStorage.getItem(beforeUnloadKey) ?? '0');
      window.sessionStorage.setItem(beforeUnloadKey, String(previous + 1));
    });

    const nativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.defineProperty(window, '__pwViteHmrUnderlyingSockets', {
      configurable: true,
      value: sockets,
    });

    function isViteHmrSocket(url: string | URL, protocols?: string | string[]): boolean {
      const protocolList = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
      return protocolList.includes('vite-hmr') || String(url).includes('vite-hmr');
    }

    const WrappedWebSocket = function WebSocket(url: string | URL, protocols?: string | string[]) {
      const socket = protocols === undefined ? new nativeWebSocket(url) : new nativeWebSocket(url, protocols);
      if (isViteHmrSocket(url, protocols)) sockets.push(socket);
      return socket;
    } as unknown as typeof WebSocket;

    Object.setPrototypeOf(WrappedWebSocket, nativeWebSocket);
    WrappedWebSocket.prototype = nativeWebSocket.prototype;
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: WrappedWebSocket,
    });
  }, { bootCountKey: BOOT_COUNT_KEY, beforeUnloadKey: BEFORE_UNLOAD_KEY });
}

async function hmrUnderlyingSocketStats(page: Page): Promise<{ count: number; open: number }> {
  return page.evaluate(() => {
    const sockets = (window as unknown as { __pwViteHmrUnderlyingSockets?: WebSocket[] }).__pwViteHmrUnderlyingSockets ?? [];
    return {
      count: sockets.length,
      open: sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
    };
  });
}

async function closeCurrentUnderlyingHmrSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sockets = (window as unknown as { __pwViteHmrUnderlyingSockets?: WebSocket[] }).__pwViteHmrUnderlyingSockets ?? [];
    const socket = sockets.find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error('No open Vite HMR websocket found to reset');
    socket.close();
  });
}

async function injectFullReloadPayload(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sockets = (window as unknown as { __pwViteHmrUnderlyingSockets?: WebSocket[] }).__pwViteHmrUnderlyingSockets ?? [];
    const socket = sockets.find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error('No open Vite HMR websocket found for full-reload payload');
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'full-reload', path: '*', timestamp: Date.now() }),
    }));
  });
}

async function openSeededSessionWithDraft(page: Page, text: string): Promise<number> {
  await installViteHmrSocketProbe(page);

  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();

  const draft = page.getByLabel('Prompt draft');
  await draft.fill(text);
  await expect(draft).toHaveValue(text);

  await expect.poll(async () => hmrUnderlyingSocketStats(page), {
    timeout: 10_000,
    message: 'expected the Vite HMR websocket to open before simulating HMR disruption',
  }).toMatchObject({ count: 1, open: 1 });

  const bootCountBeforeDisruption = await page.evaluate((key) => Number(window.sessionStorage.getItem(key) ?? '0'), BOOT_COUNT_KEY);
  expect(bootCountBeforeDisruption).toBe(1);
  return bootCountBeforeDisruption;
}

async function expectNoReloadAndDraftPreserved(page: Page, bootCountBeforeDisruption: number, draftText: string): Promise<void> {
  await expect(page.getByLabel('Prompt draft')).toHaveValue(draftText);
  await expect(page).toHaveURL(/[?&]session=seeded-session-0001/);
  await expect(await page.evaluate((key) => Number(window.sessionStorage.getItem(key) ?? '0'), BOOT_COUNT_KEY)).toBe(bootCountBeforeDisruption);
  await expect(await page.evaluate((key) => Number(window.sessionStorage.getItem(key) ?? '0'), BEFORE_UNLOAD_KEY)).toBe(0);
}

test.describe('mobile resilient HMR', () => {
  test.use({
    viewport: MOBILE,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });

  test('mobile HMR websocket reset reconnects without a full page reload', async ({ page }) => {
    const draftText = 'mobile hmr reconnect should keep this draft';
    const bootCountBeforeReset = await openSeededSessionWithDraft(page, draftText);

    // Simulate the HMR socket disappearing under the page, like a mobile
    // Wi-Fi/VPN handoff. The desired behavior is HMR reconnection, not a
    // document reload.
    await closeCurrentUnderlyingHmrSocket(page);

    await expect.poll(async () => hmrUnderlyingSocketStats(page), {
      timeout: 10_000,
      message: 'expected a fresh Vite HMR websocket to reconnect after the reset',
    }).toMatchObject({ count: 2, open: 1 });

    // Give Vite's old reload-on-disconnect path enough time to fire if the
    // resilient HMR wrapper is not installed. The repro test in the sibling
    // worktree observes the reload in well under one second on this config.
    await page.waitForTimeout(1_000);

    await expectNoReloadAndDraftPreserved(page, bootCountBeforeReset, draftText);
  });

  test('repeated mobile HMR websocket resets stay on one open socket and preserve page state', async ({ page }) => {
    const draftText = 'mobile hmr can survive repeated flaky network resets';
    const bootCountBeforeReset = await openSeededSessionWithDraft(page, draftText);

    for (let reset = 1; reset <= 5; reset++) {
      await closeCurrentUnderlyingHmrSocket(page);
      await expect.poll(async () => hmrUnderlyingSocketStats(page), {
        timeout: 10_000,
        message: `expected reset #${reset} to reconnect exactly one open Vite HMR websocket`,
      }).toMatchObject({ count: reset + 1, open: 1 });
      await expectNoReloadAndDraftPreserved(page, bootCountBeforeReset, draftText);
    }
  });

  test('mobile full-reload HMR payload is deferred instead of reloading the document', async ({ page }) => {
    const draftText = 'mobile full reload payload should not wipe this draft';
    const bootCountBeforePayload = await openSeededSessionWithDraft(page, draftText);

    await injectFullReloadPayload(page);

    // Vite's native full-reload handling is debounced by 20 ms, so this is long
    // enough to catch an accidental document reload without slowing CI much.
    await page.waitForTimeout(500);

    await expectNoReloadAndDraftPreserved(page, bootCountBeforePayload, draftText);
    await expect(page.getByRole('button', { name: 'Reload app to apply deferred frontend update' })).toBeVisible();
  });

  test('tapping the deferred full-reload button performs an explicit user-controlled reload', async ({ page }) => {
    const draftText = 'manual reload button is the user-controlled escape hatch';
    const bootCountBeforePayload = await openSeededSessionWithDraft(page, draftText);

    await injectFullReloadPayload(page);
    const reloadButton = page.getByRole('button', { name: 'Reload app to apply deferred frontend update' });
    await expect(reloadButton).toBeVisible();
    await expectNoReloadAndDraftPreserved(page, bootCountBeforePayload, draftText);

    const navigation = page.waitForEvent('framenavigated', { timeout: 10_000 });
    await reloadButton.click();
    await navigation;
    await page.waitForLoadState('domcontentloaded');

    await expect.poll(async () => page.evaluate((key) => Number(window.sessionStorage.getItem(key) ?? '0'), BOOT_COUNT_KEY), {
      timeout: 10_000,
      message: 'expected the explicit reload button to reload the document',
    }).toBeGreaterThan(bootCountBeforePayload);
    await expect(await page.evaluate((key) => Number(window.sessionStorage.getItem(key) ?? '0'), BEFORE_UNLOAD_KEY)).toBeGreaterThanOrEqual(1);
    const navigationType = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.toJSON?.().type ?? 'unknown');
    expect(navigationType).toBe('reload');
  });
});
