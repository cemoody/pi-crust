/**
 * Failing TDD spec: the WUI must not refetch the full `/messages` payload on
 * every SSE (re)connect.
 *
 * Symptom in production: the network panel shows two ~29 MB
 * `GET /api/sessions/:id/messages` calls back-to-back when opening a session
 * — one for initial mount and a second triggered by the SSE handshake. The
 * second call doubles network cost and CPU for no benefit, because the SSE
 * stream already replays missed events from the server-side ring.
 *
 * Contract pinned here: opening a single session in a fresh tab issues AT
 * MOST one /messages request for that session. Any further updates come over
 * the events stream.
 *
 * This test currently FAILS.
 */
import { expect, test } from "@playwright/test";

// Must match playwright.config.ts → VITE_PI_REMOTE_API_BASE.
const API_BASE = "http://127.0.0.1:9787";

function attachMessagesCounter(page: import("@playwright/test").Page): { snapshot: () => readonly string[] } {
  const messageFetches: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(API_BASE)) return;
    if (/\/api\/sessions\/[^/?#]+\/messages(?:[?#]|$)/.test(url) && request.method() === "GET") {
      messageFetches.push(url);
    }
  });
  return { snapshot: () => [...messageFetches] };
}

// React.StrictMode (enabled in vite dev) intentionally double-invokes effects
// to surface side-effect bugs. The dev server we test against runs in dev
// mode, so each `useEffect` body that calls api.getMessages will fire twice
// on mount. In production (no StrictMode) the same path fires once. We
// budget for the StrictMode doubling here — the real bug we're guarding
// against is a *third* fetch triggered by SSE replay / stream events on
// top of the mount fetches.
const MOUNT_FETCH_BUDGET = 2;

test("initial mount fetches /messages with a ?limit= window, not the entire transcript", async ({ page }) => {
  // Background: on a 35 MB session, GET /messages without ?limit forces the
  // server to slurp + JSON.parse the whole jsonl (~19 s of synchronous CPU)
  // and ships back tens of MB. The server already supports a tail-windowed
  // read via ?limit (PR #102), but the WUI never used it — so opening a long
  // session blocked the event loop for the entire ~19 s.
  // The WUI must pass ?limit on the initial mount fetch.
  const counter = attachMessagesCounter(page);

  await page.goto("/");
  await page.getByRole("link", { name: /^Seeded session\b/ }).click();
  await expect(page.getByText("previously sent hello")).toBeVisible();
  // Let the mount settle so any debounced fetches finish.
  await page.waitForTimeout(500);

  const fetches = counter.snapshot();
  expect(fetches.length, `expected at least one /messages fetch on mount, got: ${JSON.stringify(fetches)}`).toBeGreaterThan(0);
  for (const url of fetches) {
    expect(url, `every initial /messages fetch must carry a ?limit= window, got: ${url}`).toMatch(/[?&]limit=\d+/);
  }
});

test("reloading the page on an active session does not trigger a third /messages fetch from SSE replay", async ({ page }) => {
  // This is the production-shaped repro: after a session has any recent
  // agent activity, opening it (or reloading the tab) replays the server
  // event ring, which fires scheduleRefresh() in SessionDashboard — hence
  // the two-/messages waterfall in the screenshot.
  await page.goto("/");
  await page.getByRole("link", { name: /^Seeded session\b/ }).click();
  await expect(page.getByText("previously sent hello")).toBeVisible();

  // Seed agent-end / message-end into the ring so the next SSE handshake
  // has something to replay.
  await page.getByLabel("Prompt draft").fill("prime-ring");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Mock response to: prime-ring", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);

  // Now reload the tab and start counting /messages only after navigation.
  const counter = attachMessagesCounter(page);
  await page.reload();
  await expect(page.getByText("Mock response to: prime-ring", { exact: true })).toBeVisible();
  await page.waitForTimeout(2_000);

  // The first MOUNT_FETCH_BUDGET fetches come from React effect mounting
  // (doubled by StrictMode in dev). Anything beyond that means an event-
  // stream replay triggered a redundant refetch — that's the bug.
  const fetches = counter.snapshot();
  expect(fetches.length, `expected ≤${MOUNT_FETCH_BUDGET} /messages fetches on reload, got: ${JSON.stringify(fetches)}`).toBeLessThanOrEqual(MOUNT_FETCH_BUDGET);
});

test("streaming a prompt does not trigger additional /messages refetches", async ({ page }) => {
  // This is the production-shaped bug: when the SSE stream emits
  // message_end / agent_end (as it does after any prompt), SessionDashboard
  // currently calls scheduleRefresh() which fires another GET /messages.
  // A correct implementation should rely on the streamed events alone for
  // incremental updates.
  const counter = attachMessagesCounter(page);

  await page.goto("/");
  await page.getByRole("link", { name: /^Seeded session\b/ }).click();
  await expect(page.getByText("previously sent hello")).toBeVisible();

  // Initial mount may issue at most 1 /messages. Anything after this point
  // should be 0 — incremental message rendering must come from the SSE
  // stream, not from refetching the entire transcript.
  const baseline = counter.snapshot().length;

  await page.getByLabel("Prompt draft").fill("trigger-stream");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Mock response to: trigger-stream", { exact: true })).toBeVisible();

  // Let any post-stream scheduleRefresh() debounce (80 ms today) fire.
  await page.waitForTimeout(2_000);

  const after = counter.snapshot();
  const extraFetches = after.slice(baseline);
  expect(extraFetches, `unexpected post-stream /messages refetches: ${JSON.stringify(extraFetches)}`).toEqual([]);
});
