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
import fs from "node:fs";
import path from "node:path";

const API_BASE = "http://127.0.0.1:9789";
const SESSION_ID = "seeded-session-0001";
const SOCKET_IO_CLIENT = path.resolve(
  process.cwd(),
  "node_modules/socket.io-client/dist/socket.io.min.js",
);

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

test("normal Socket.IO startup does not fall back to SSE", async ({ browser }) => {
  const context = await browser.newContext();
  await freshBaseline(context);

  const page = await context.newPage();
  const errors = trackErrors(page);
  await page.goto(`/?session=${SESSION_ID}`);

  await expect.poll(() => connections(page.request), { timeout: 20_000 }).toBe(1);
  const stats = await page.request.get(`${API_BASE}/api/client-event/stats?windowMs=60000`).then((r) => r.json());
  expect(stats.byKind["realtime-fallback"] ?? 0).toBe(0);
  expect(stats.byKind["realtime-fallback-active"] ?? 0).toBe(0);
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
  await context.close();
});

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

test("same-origin /socket.io endpoint connects from the browser", async ({ browser }) => {
  const context = await browser.newContext();
  await freshBaseline(context);
  const page = await context.newPage();
  const errors = trackErrors(page);
  await page.goto(`/?session=${SESSION_ID}`);
  await page.addScriptTag({ content: fs.readFileSync(SOCKET_IO_CLIENT, "utf8") });

  const connected = await page.evaluate(async () => {
    const io = (window as unknown as { io?: any }).io;
    if (!io) throw new Error("socket.io-client failed to load");
    const socket = io(window.location.origin, { path: "/socket.io/", transports: ["websocket"], reconnection: false, timeout: 1_500 });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket.io same-origin timeout")), 2_000);
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
        socket.once("connect_error", (error: unknown) => { clearTimeout(timer); reject(error); });
      });
      return socket.connected;
    } finally {
      socket.disconnect();
    }
  });

  expect(connected).toBe(true);
  expect(errors.pageErrors).toEqual([]);
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

// This is the production-ish race from the 2026-05-29 incident: Socket.IO is
// unavailable at startup, the user sends a prompt before SSE fallback is fully
// active, and the final answer is persisted server-side. The UI must eventually
// catch up without a manual reload; fallback needs to behave like a reconnect
// boundary and refetch /messages if live events may have been missed.
test("fallback catches up when a prompt is sent before SSE is fully established", async ({ browser }) => {
  const context = await browser.newContext();
  await freshBaseline(context);
  await context.route("**/socket.io/**", (route) => route.abort());

  const page = await context.newPage();
  const errors = trackErrors(page, /socket\.io/);
  await page.goto(`/?session=${SESSION_ID}`);

  await page.getByLabel("Prompt draft").fill("hello-during-fallback-race");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Mock response to: hello-during-fallback-race", { exact: true }))
    .toBeVisible({ timeout: 20_000 });

  expect(errors.pageErrors, "no uncaught exceptions during fallback race").toEqual([]);
  await context.close();
});

test("Socket.IO fallback recovers every visible tab on the same session", async ({ browser }) => {
  const context = await browser.newContext();
  await freshBaseline(context);
  await context.route("**/socket.io/**", (route) => route.abort());

  const first = await context.newPage();
  const second = await context.newPage();
  const firstErrors = trackErrors(first, /socket\.io/);
  const secondErrors = trackErrors(second, /socket\.io/);
  await first.goto(`/?session=${SESSION_ID}`);
  await second.goto(`/?session=${SESSION_ID}`);

  await first.getByLabel("Prompt draft").fill("hello-fallback-all-tabs");
  await first.getByRole("button", { name: "Send" }).click();

  await expect(first.getByText("Mock response to: hello-fallback-all-tabs", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(second.getByText("Mock response to: hello-fallback-all-tabs", { exact: true })).toBeVisible({ timeout: 20_000 });

  expect(firstErrors.pageErrors).toEqual([]);
  expect(secondErrors.pageErrors).toEqual([]);
  await context.close();
});
