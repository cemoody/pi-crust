/**
 * Reproduction for the SSE-pool starvation bug.
 *
 * Symptom (production): with several WUI tabs open (or after rapidly switching
 * sessions in one tab, which leaks SSE streams), the next page load hangs for
 * tens of seconds even though the api responds in <2 ms on the box.
 *
 * Root cause: Chrome (and Firefox, Safari) cap HTTP/1.1 connections per origin
 * at 6. The api is HTTP/1.1, and each session-`/events` EventSource holds one
 * connection open indefinitely. Once ≥6 are alive against the same origin,
 * every other fetch to that origin queues until one frees.
 *
 * These tests open N EventSources against the api origin, then measure how
 * long a fresh fetch to the same origin takes. The FIRST test reproduces the
 * starvation. The SECOND test verifies the eviction-by-tabSessionId fix once
 * implemented: opening a new SSE with the same `tabSessionId` as an existing
 * one causes the server to close the previous stream, freeing a slot.
 */
import { test, expect, type Page } from "@playwright/test";

// Playwright config wires the WUI to a dedicated API on this origin (see
// playwright.config.ts → VITE_PI_REMOTE_API_BASE). All SSE/fetch goes here.
const API_BASE = "http://127.0.0.1:9787";

// Chrome's per-origin HTTP/1.1 limit. Empirically and historically 6.
const POOL_LIMIT = 6;

// How long we wait before deciding "this fetch is stuck behind the pool".
const STARVATION_THRESHOLD_MS = 2_000;

/**
 * Open `count` SSE streams against the api inside the page. Resolves once all
 * of them reach EventSource.OPEN. Returns a `holderId` the page-side script
 * uses to track them; pass it to `closeOneSse` / `closeAllSse` to tear down.
 */
async function openSseStreams(page: Page, count: number, tabSessionId?: string): Promise<string> {
  return page.evaluate(async ({ apiBase, count, tabSessionId }) => {
    const holderId = `holder-${Math.random().toString(36).slice(2)}`;
    const sources: EventSource[] = [];
    (window as any).__sseHolders ??= new Map<string, EventSource[]>();
    (window as any).__sseHolders.set(holderId, sources);
    const sessionId = "seeded-session-0001";
    const tabParam = tabSessionId ? `?tabSessionId=${encodeURIComponent(tabSessionId)}` : "";
    const url = `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/events${tabParam}`;
    await Promise.all(
      Array.from({ length: count }, () => new Promise<void>((resolve, reject) => {
        const es = new EventSource(url);
        sources.push(es);
        const onReady = () => { es.removeEventListener("ready", onReady as EventListener); resolve(); };
        es.addEventListener("ready", onReady as EventListener);
        // Fallback: also resolve on onopen in case ready hasn't been parsed yet.
        es.addEventListener("open", () => resolve(), { once: true });
        es.addEventListener("error", () => reject(new Error("SSE failed to open")), { once: true });
      })),
    );
    return holderId;
  }, { apiBase: API_BASE, count, tabSessionId });
}

async function closeOneSse(page: Page, holderId: string): Promise<void> {
  await page.evaluate((holderId) => {
    const sources = (window as any).__sseHolders?.get(holderId) as EventSource[] | undefined;
    if (!sources || sources.length === 0) throw new Error(`no holder ${holderId}`);
    const victim = sources.shift()!;
    victim.close();
  }, holderId);
}

async function closeAllSse(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as any).__sseHolders as Map<string, EventSource[]> | undefined;
    if (!map) return;
    for (const sources of map.values()) {
      for (const es of sources) es.close();
    }
    map.clear();
  });
}

/**
 * Time how long a fresh fetch to the api takes from inside the page.
 * `softTimeoutMs` aborts if exceeded — useful for the starvation test where we
 * don't want the assertion to hang for the full Playwright timeout.
 */
async function timedFetch(page: Page, pathRel: string, softTimeoutMs: number): Promise<{ ms: number; aborted: boolean; status: number | null }> {
  return page.evaluate(async ({ apiBase, pathRel, softTimeoutMs }) => {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), softTimeoutMs);
    try {
      const res = await fetch(`${apiBase}${pathRel}`, { signal: ctl.signal, cache: "no-store" });
      return { ms: performance.now() - t0, aborted: false, status: res.status };
    } catch {
      return { ms: performance.now() - t0, aborted: true, status: null };
    } finally {
      clearTimeout(timer);
    }
  }, { apiBase: API_BASE, pathRel, softTimeoutMs });
}

test.describe("SSE connection-pool starvation (repro)", () => {
  test.afterEach(async ({ page }) => {
    // Free the pool so subsequent tests aren't starved by leaked sources.
    await closeAllSse(page).catch(() => undefined);
  });

  test("baseline: a single fetch to /api/health is fast (<200 ms)", async ({ page }) => {
    await page.goto("/");
    const result = await timedFetch(page, "/api/health", 5_000);
    expect(result.aborted).toBe(false);
    expect(result.status).toBe(200);
    expect(result.ms).toBeLessThan(200);
  });

  test(`${POOL_LIMIT} concurrent SSE streams stall the next fetch to the same origin`, async ({ page }) => {
    await page.goto("/");
    await openSseStreams(page, POOL_LIMIT);

    // With POOL_LIMIT long-lived connections holding the per-origin pool,
    // a fresh fetch should sit in "queued" state. Abort after our threshold
    // so the test fails *fast* if the bug is fixed (good signal for inverting
    // the assertion in the eviction PR).
    const result = await timedFetch(page, "/api/health", STARVATION_THRESHOLD_MS + 500);
    expect.soft(result.aborted, "fetch should NOT have completed in time — bug repro").toBe(true);
    expect.soft(result.ms).toBeGreaterThanOrEqual(STARVATION_THRESHOLD_MS);
  });

  test("closing one SSE immediately unblocks the queued fetch", async ({ page }) => {
    await page.goto("/");
    const holder = await openSseStreams(page, POOL_LIMIT);

    // Kick off a fetch in the page that we expect to be queued behind the
    // POOL_LIMIT SSE streams. We don't await it yet; we just hand back a
    // handle whose duration we'll measure after closing one SSE.
    const fetchHandle = page.evaluate(async ({ apiBase }) => {
      const t0 = performance.now();
      const res = await fetch(`${apiBase}/api/health`, { cache: "no-store" });
      return { ms: performance.now() - t0, status: res.status };
    }, { apiBase: API_BASE });

    // Briefly confirm it's queued, then free one slot.
    await page.waitForTimeout(500);
    await closeOneSse(page, holder);

    const result = await fetchHandle;
    expect(result.status).toBe(200);
    // Total time is dominated by the 500 ms wait above + a tiny round-trip.
    expect(result.ms).toBeLessThan(2_000);
    expect(result.ms).toBeGreaterThanOrEqual(450);
  });
});

test.describe("SSE eviction by tabSessionId (fix)", () => {
  test.afterEach(async ({ page }) => {
    await closeAllSse(page).catch(() => undefined);
  });

  /**
   * Opening a new SSE with the same `tabSessionId` as an already-open SSE on
   * the api causes the server to write an `event: evicted` line and `.end()`
   * the prior response. The browser then receives the FIN and frees the pool
   * slot. That means N rapid session-switches inside one tab can never
   * accumulate more than 1 server-side SSE per tab.
   */
  test("same tabSessionId across N SSE opens leaves at most 1 active stream", async ({ page }) => {
    await page.goto("/");

    const tabSessionId = "test-tab-abc";
    // Open POOL_LIMIT+1 streams sequentially with the same tabSessionId so the
    // server sees each one supersede the prior. If eviction works, only the
    // last is active on the server AND the browser pool stays free, so the
    // final fetch resolves quickly. If eviction is broken, the browser would
    // already be stalled by stream #7 (or actually stuck opening it).
    for (let i = 0; i < POOL_LIMIT + 1; i++) {
      // openSseStreams waits for `ready` on each new EventSource, so this
      // sequence is naturally serialized: stream i is OPEN before stream i+1
      // is requested.
      await openSseStreams(page, 1, tabSessionId);
    }

    const result = await timedFetch(page, "/api/health", 5_000);
    expect(result.aborted).toBe(false);
    expect(result.status).toBe(200);
    expect(result.ms).toBeLessThan(500);
  });

  test("different tabSessionIds do NOT evict each other", async ({ page }) => {
    // Sanity: two distinct tab ids should both stay open. This guards against
    // an over-eager eviction policy that would kick off legitimate parallel
    // tabs viewing different sessions.
    await page.goto("/");
    await openSseStreams(page, 1, "tab-A");
    await openSseStreams(page, 1, "tab-B");
    const active = await page.evaluate(() => {
      const all = Array.from(((window as any).__sseHolders as Map<string, EventSource[]>).values()).flat();
      return all.filter((es: EventSource) => es.readyState === EventSource.OPEN).length;
    });
    expect(active).toBe(2);
  });
});
