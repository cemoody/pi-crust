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

test("reloading the page on an active session does not trigger a second /messages fetch from SSE replay", async ({ page }) => {
  // This is the production-shaped repro: after a session has any recent
  // agent activity, opening it (or reloading the tab) replays the server
  // event ring, which fires scheduleRefresh() in SessionDashboard — hence
  // the two-/messages waterfall in the screenshot.
  await page.goto("/");
  await page.getByRole("button", { name: /^Seeded session\b/ }).click();
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

  // Exactly one initial fetch is acceptable. A second one (driven by SSE
  // replay of the ring) is the bug.
  const fetches = counter.snapshot();
  expect(fetches.length, `expected ≤1 /messages fetch on reload, got: ${JSON.stringify(fetches)}`).toBeLessThanOrEqual(1);
});

test("streaming a prompt does not trigger additional /messages refetches", async ({ page }) => {
  // This is the production-shaped bug: when the SSE stream emits
  // message_end / agent_end (as it does after any prompt), SessionDashboard
  // currently calls scheduleRefresh() which fires another GET /messages.
  // A correct implementation should rely on the streamed events alone for
  // incremental updates.
  const counter = attachMessagesCounter(page);

  await page.goto("/");
  await page.getByRole("button", { name: /^Seeded session\b/ }).click();
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
