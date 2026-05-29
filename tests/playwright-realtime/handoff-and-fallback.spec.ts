/**
 * End-to-end resilience proofs for the Socket.IO transport (flag ENABLED):
 *   1. Backgrounding the leader tab hands off to a visible follower (the #1
 *      review fix) — streaming keeps working and there is still exactly ONE
 *      server socket (not zero).
 *   2. Closing the leader tab promotes a follower (ungraceful loss).
 *   3. If the Socket.IO gateway is unreachable, the app falls back to SSE and
 *      still streams.
 *
 * Run: npx playwright test --config=playwright.realtime.config.ts
 */
import { test, expect, type APIRequestContext, type BrowserContext, type ConsoleMessage, type Page } from "@playwright/test";

const API_BASE = "http://127.0.0.1:9789";
const SESSION_ID = "seeded-session-0001";

function isBenign(text: string, url: string): boolean {
  // Telemetry beacon 502 (dev-proxy default port) is unrelated noise.
  return /client-event/.test(url) && /502|Bad Gateway|Failed to load resource/.test(text);
}

function trackErrors(page: Page, alsoIgnore?: RegExp): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const url = msg.location()?.url ?? "";
    if (isBenign(msg.text(), url)) return;
    if (alsoIgnore && (alsoIgnore.test(url) || alsoIgnore.test(msg.text()))) return;
    consoleErrors.push(`${msg.text()} @ ${url}`);
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  return { consoleErrors, pageErrors };
}

async function connections(req: APIRequestContext): Promise<number> {
  const res = await req.get(`${API_BASE}/api/realtime/stats`);
  return (await res.json()).connections as number;
}

/** Serial tests share one server + a process-global connection count. Wait for
 *  any sockets left by a previous test to drain so each test starts clean. */
async function freshBaseline(context: BrowserContext): Promise<void> {
  await context.request.get(`${API_BASE}/api/sessions`); // warm cold-session map
  await expect.poll(() => connections(context.request), { timeout: 15_000 }).toBe(0);
}

/** Simulate backgrounding a tab: force document.visibilityState=hidden and
 *  fire the event the app listens for. */
async function background(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("backgrounding the leader hands off to a visible follower; streaming continues", async ({ browser }) => {
  const context = await browser.newContext();
  await freshBaseline(context);

  // Open the leader FIRST and let it become the sole connection, so it is
  // deterministically the elected leader before the follower joins.
  const leaderTab = await context.newPage();
  const leaderErrors = trackErrors(leaderTab);
  await leaderTab.goto(`/?session=${SESSION_ID}`);
  await expect.poll(() => connections(leaderTab.request), { timeout: 20_000 }).toBe(1);

  const followerTab = await context.newPage();
  const followerErrors = trackErrors(followerTab);
  await followerTab.goto(`/?session=${SESSION_ID}`);
  // Follower joins the existing leader — still exactly one socket.
  await expect.poll(() => connections(followerTab.request), { timeout: 20_000 }).toBe(1);

  // Background the leader. Before the fix this would drop the only socket to 0
  // and starve the follower; after the fix the follower is promoted → stays 1.
  await background(leaderTab);
  await expect.poll(() => connections(followerTab.request), { timeout: 15_000 }).toBe(1);

  // Streaming still works in the visible follower tab.
  await followerTab.getByLabel("Prompt draft").fill("hello-after-handoff");
  await followerTab.getByRole("button", { name: "Send" }).click();
  await expect(followerTab.getByText("Mock response to: hello-after-handoff", { exact: true })).toBeVisible({ timeout: 15_000 });

  expect(followerErrors.pageErrors, "follower uncaught exceptions").toEqual([]);
  expect(followerErrors.consoleErrors, "follower console errors").toEqual([]);
  expect(leaderErrors.pageErrors, "leader uncaught exceptions").toEqual([]);

  await context.close();
});

test("closing the leader tab promotes a follower (ungraceful loss)", async ({ browser }) => {
  const context = await browser.newContext();
  await freshBaseline(context);

  const leaderTab = await context.newPage();
  await leaderTab.goto(`/?session=${SESSION_ID}`);
  await expect.poll(() => connections(leaderTab.request), { timeout: 20_000 }).toBe(1);
  const followerTab = await context.newPage();
  const followerErrors = trackErrors(followerTab);
  await followerTab.goto(`/?session=${SESSION_ID}`);
  await expect.poll(() => connections(followerTab.request), { timeout: 20_000 }).toBe(1);

  // Kill the leader tab outright (no graceful goodbye). The follower must
  // detect the dead leader via heartbeat-timeout and take over.
  await leaderTab.close();
  await expect.poll(() => connections(followerTab.request), { timeout: 20_000 }).toBe(1);

  await followerTab.getByLabel("Prompt draft").fill("hello-after-close");
  await followerTab.getByRole("button", { name: "Send" }).click();
  await expect(followerTab.getByText("Mock response to: hello-after-close", { exact: true })).toBeVisible({ timeout: 15_000 });

  expect(followerErrors.pageErrors).toEqual([]);
  await context.close();
});

test("falls back to SSE and still streams when the Socket.IO gateway is unreachable", async ({ browser }) => {
  const context = await browser.newContext();
  await freshBaseline(context);
  // Break Socket.IO at the network layer: every /socket.io/ request aborts, so
  // the client should exhaust its connect attempts and fall back to SSE.
  await context.route("**/socket.io/**", (route) => route.abort());

  const page = await context.newPage();
  // Aborted socket.io requests surface as console errors; those are expected.
  const errors = trackErrors(page, /socket\.io/);
  await page.goto(`/?session=${SESSION_ID}`);

  // No Socket.IO connection should ever establish.
  await expect.poll(() => connections(page.request), { timeout: 10_000 }).toBe(0);

  // SSE still delivers the stream end to end.
  await page.getByLabel("Prompt draft").fill("hello-over-sse");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Mock response to: hello-over-sse", { exact: true })).toBeVisible({ timeout: 15_000 });

  expect(errors.pageErrors, "no uncaught exceptions during fallback").toEqual([]);
  await context.close();
});
