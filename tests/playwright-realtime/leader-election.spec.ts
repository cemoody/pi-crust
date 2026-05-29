/**
 * End-to-end leader-election proof (Socket.IO transport ENABLED).
 *
 * Opens N real tabs of the app, all viewing the same session. The client uses
 * the multiplexed Socket.IO connection with BroadcastChannel leader election,
 * so the server must end up with EXACTLY ONE physical socket connection across
 * all tabs — the headline "many tabs / many connections" fix — and no tab may
 * log a console error or throw.
 *
 * Run: npx playwright test --config=playwright.realtime.config.ts
 */
import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

const API_BASE = "http://127.0.0.1:9789";
const TAB_COUNT = 6;
const SESSION_ID = "seeded-session-0001";

function isBenign(text: string, url: string): boolean {
  return /client-event/.test(url) && /502|Bad Gateway|Failed to load resource/.test(text);
}

function trackErrors(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const url = msg.location()?.url ?? "";
    if (isBenign(msg.text(), url)) return;
    consoleErrors.push(`${msg.text()} @ ${url}`);
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  return { consoleErrors, pageErrors };
}

async function connections(request: import("@playwright/test").APIRequestContext): Promise<number> {
  const res = await request.get(`${API_BASE}/api/realtime/stats`);
  const body = await res.json();
  return body.connections as number;
}

test("N app tabs collapse to ONE server socket via leader election", async ({ browser }) => {
  const context = await browser.newContext();

  // Warm the server's cold-session map. getOrOpenSession (used by BOTH the SSE
  // route and the gateway's subscribe) can only open a session whose file has
  // been discovered via a prior /api/sessions list. Deep-linking a never-listed
  // session is a separate pre-existing race; warm it so this test isolates
  // leader election.
  await context.request.get(`${API_BASE}/api/sessions`);
  // Serial tests share one server + a process-global connection count; wait for
  // any sockets left by a previous test to drain so we start from a clean base.
  await expect.poll(() => connections(context.request), { timeout: 15_000 }).toBe(0);

  const pages: Page[] = [];
  const errors: ReturnType<typeof trackErrors>[] = [];

  for (let i = 0; i < TAB_COUNT; i += 1) {
    const page = await context.newPage();
    errors.push(trackErrors(page));
    await page.goto(`/?session=${SESSION_ID}`);
    pages.push(page);
  }

  // Election settles asynchronously (every tab races, losers step down). Poll
  // until the server reports a stable single connection.
  await expect.poll(async () => connections(pages[0]!.request), {
    timeout: 20_000,
    intervals: [250, 500, 1_000],
  }).toBe(1);

  // Hold steady: still exactly one a moment later (no flapping / re-election).
  await pages[0]!.waitForTimeout(1_500);
  expect(await connections(pages[0]!.request)).toBe(1);

  // No tab logged an error or threw.
  errors.forEach((tab, index) => {
    expect(tab.pageErrors, `tab ${index} uncaught exceptions`).toEqual([]);
    expect(tab.consoleErrors, `tab ${index} console errors`).toEqual([]);
  });

  await context.close();
});
