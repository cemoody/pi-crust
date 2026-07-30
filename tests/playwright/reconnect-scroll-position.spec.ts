import { expect, test } from "@playwright/test";

const API_BASE = "http://127.0.0.1:9787";
const SESSION_ID = "seeded-session-long-pagination";
const HISTORY_MARKER = "turn-485-user: user message number 485";
const RECONNECT_PROMPT = "reconnect-scroll-position-regression";

/**
 * Regression for reconnects resetting the reader's place in session history.
 *
 * It makes the browser network go offline while the reader is looking at an
 * older message, writes a response through Playwright's independent API
 * client, and restores the browser network. The application's real-time
 * transport then reconnects and catches up. The reader's anchor must stay put.
 */
test("reconnect preserves the visible position in session history", async ({ page }) => {
  const reconnectCatchups: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (request.method() === "GET" && /\/api\/sessions\/[^/]+\/messages\?/.test(url) && new URL(url).searchParams.has("after")) {
      reconnectCatchups.push(url);
    }
  });

  const cdp = await page.context().newCDPSession(page);
  let socketConnections = 0;
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketCreated", ({ url }) => {
    if (url.includes("127.0.0.1:9787/socket.io")) socketConnections += 1;
  });

  await page.goto("/");
  await page.getByRole("link", { name: /^Long pagination session\b/ }).click();

  const timeline = page.locator(".message-timeline");
  const marker = timeline.getByText(HISTORY_MARKER, { exact: true });
  await expect(marker).toBeVisible();

  // Read an older turn instead of remaining pinned to the latest response.
  await marker.scrollIntoViewIfNeeded();
  await timeline.hover();
  await page.mouse.wheel(0, -300);
  // Chromium applies wheel movement asynchronously; snapshot after its
  // inertial scroll has settled, before we introduce the network outage.
  await page.waitForTimeout(500);
  const before = await scrollAnchor(page, HISTORY_MARKER);
  expect(before.scrollTop, "test must be reading away from the timeline top").toBeGreaterThan(0);

  // This drops the app's Socket.IO/SSE connection just as a laptop sleep or
  // Wi-Fi handoff does. page.request is outside the page network stack and can
  // write the missed response while the app remains disconnected.
  await expect.poll(() => socketConnections, { message: "expected the live Socket.IO transport" }).toBeGreaterThan(0);
  const connectionsBeforeDrop = socketConnections;
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  const response = await page.request.post(`${API_BASE}/api/sessions/${SESSION_ID}/prompt`, {
    data: { text: RECONNECT_PROMPT },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  await expect.poll(() => socketConnections, {
    timeout: 15_000,
    message: "expected a fresh Socket.IO connection after restoring network",
  }).toBeGreaterThan(connectionsBeforeDrop);
  // The reconnect marker must use the incremental cursor path. A bounded-tail
  // replacement would throw away any older history the reader had loaded.
  await expect.poll(() => reconnectCatchups.length, {
    timeout: 15_000,
    message: "expected reconnect to request only the missing message suffix",
  }).toBeGreaterThan(0);
  const after = await scrollAnchor(page, HISTORY_MARKER);
  expect(after.scrollTop, "reconnect must not reset timeline scroll").toBeCloseTo(before.scrollTop, 0);
  expect(after.offsetFromTimelineTop, "the message being read must stay visually anchored").toBeCloseTo(before.offsetFromTimelineTop, 0);
});

async function scrollAnchor(page: import("@playwright/test").Page, text: string): Promise<{ scrollTop: number; offsetFromTimelineTop: number }> {
  return page.locator(".message-timeline").evaluate((timeline, markerText) => {
    const marker = Array.from(timeline.querySelectorAll<HTMLElement>("article.message-card"))
      .find((element) => element.textContent?.includes(markerText));
    if (!marker) throw new Error(`history marker is no longer rendered: ${markerText}`);
    const timelineRect = timeline.getBoundingClientRect();
    return { scrollTop: timeline.scrollTop, offsetFromTimelineTop: marker.getBoundingClientRect().top - timelineRect.top };
  }, text);
}
