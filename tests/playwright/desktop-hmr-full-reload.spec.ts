import { expect, test, type Page } from '@playwright/test';

const BOOT_COUNT_KEY = '__pw_desktop_hmr_full_reload_boot_count';
const BEFORE_UNLOAD_KEY = '__pw_desktop_hmr_full_reload_beforeunload_count';

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

async function waitForOpenHmrSocket(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => {
    const sockets = (window as unknown as { __pwViteHmrUnderlyingSockets?: WebSocket[] }).__pwViteHmrUnderlyingSockets ?? [];
    return sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length;
  }), {
    timeout: 10_000,
    message: 'expected the Vite HMR websocket to open before injecting a full-reload payload',
  }).toBe(1);
}

test('desktop full-reload HMR payload keeps Vite default behavior and reloads the document', async ({ page }) => {
  await installViteHmrSocketProbe(page);

  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).click();
  await waitForOpenHmrSocket(page);

  const bootCountBeforePayload = await page.evaluate((key) => Number(window.sessionStorage.getItem(key) ?? '0'), BOOT_COUNT_KEY);
  expect(bootCountBeforePayload).toBe(1);

  const navigation = page.waitForEvent('framenavigated', { timeout: 10_000 });
  await page.evaluate(() => {
    const sockets = (window as unknown as { __pwViteHmrUnderlyingSockets?: WebSocket[] }).__pwViteHmrUnderlyingSockets ?? [];
    const socket = sockets.find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error('No open Vite HMR websocket found for full-reload payload');
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'full-reload', path: '*', timestamp: Date.now() }),
    }));
  });
  await navigation;
  await page.waitForLoadState('domcontentloaded');

  await expect.poll(async () => page.evaluate((key) => Number(window.sessionStorage.getItem(key) ?? '0'), BOOT_COUNT_KEY), {
    timeout: 10_000,
    message: 'expected desktop Vite full-reload payload to reload the document',
  }).toBeGreaterThan(bootCountBeforePayload);
  await expect(await page.evaluate((key) => Number(window.sessionStorage.getItem(key) ?? '0'), BEFORE_UNLOAD_KEY)).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole('button', { name: 'Reload app to apply deferred frontend update' })).toHaveCount(0);
  const navigationType = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.toJSON?.().type ?? 'unknown');
  expect(navigationType).toBe('reload');
});
