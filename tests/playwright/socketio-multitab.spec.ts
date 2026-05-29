/**
 * Multi-tab realtime PRESSURE test for the Socket.IO gateway.
 *
 * Opens several browser tabs on the same origin. Each tab:
 *   1. creates its own session,
 *   2. opens ONE multiplexed Socket.IO connection to the gateway,
 *   3. subscribes and fires a sustained burst prompt (`@@burst 50 20000` — the
 *      mock adapter emits one text_delta every 50ms for 20s, ~400 events),
 *   4. records every streamed event with arrival timestamps.
 *
 * Asserts, under ~2400 events streaming across 6 concurrent sessions for 20s:
 *   - each tab received its full sustained stream (≈400 deltas) in order,
 *   - zero cross-talk (no tab ever saw another session's events),
 *   - all tabs streamed SIMULTANEOUSLY (their active windows overlap) and the
 *     stream was sustained over the full 20s (not buffered-then-flushed),
 *   - no tab logged a transport/console error or threw.
 *
 * No LLM key required: the server runs the mock adapter (PI_CRUST_USE_MOCK=1).
 */
import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "http://127.0.0.1:9787";
const TAB_COUNT = 6; // == Chrome's historical per-origin HTTP/1.1 budget.
const BURST_INTERVAL_MS = 50;
const BURST_DURATION_MS = 20_000;
const EXPECTED_TICKS = BURST_DURATION_MS / BURST_INTERVAL_MS; // ~400
const SOCKET_IO_CLIENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/socket.io-client/dist/socket.io.min.js",
);

// 20s of streaming + setup/teardown needs more than the 30s default.
test.setTimeout(60_000);

interface TabErrors {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

// The app fires a fire-and-forget telemetry beacon to /api/client-event. In
// the Playwright harness the Vite dev proxy forwards that to its default API
// port (8787) rather than the test API (9787), so it 502s. That noise is
// unrelated to the realtime transport under test; everything else (socket.io,
// websocket, uncaught exceptions) must stay clean.
function isBenign(text: string, url: string): boolean {
  return /client-event/.test(url) && /502|Bad Gateway|Failed to load resource/.test(text);
}

function trackErrors(page: Page): TabErrors {
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

test("N tabs stream sustained concurrent bursts over the gateway with no errors", async ({ browser }) => {
  const context = await browser.newContext();

  // Borrow an allowed cwd from the seeded session so per-tab createSession
  // passes the server path policy.
  const probe = await context.newPage();
  await probe.goto("/");
  const cwd = await probe.evaluate(async (apiBase) => {
    const res = await fetch(`${apiBase}/api/sessions`);
    const body = await res.json();
    const cards = Array.isArray(body) ? body : body.sessions ?? [];
    return cards[0]?.cwd as string | undefined;
  }, API_BASE);
  expect(cwd, "expected a seeded session to borrow a cwd from").toBeTruthy();
  await probe.close();

  const pages: Page[] = [];
  const errors: TabErrors[] = [];
  for (let i = 0; i < TAB_COUNT; i += 1) {
    const page = await context.newPage();
    errors.push(trackErrors(page));
    await page.goto("/");
    await page.addScriptTag({ path: SOCKET_IO_CLIENT });
    pages.push(page);
  }

  const results = await Promise.all(pages.map((page, index) =>
    page.evaluate(async ({ apiBase, cwd, index, intervalMs, durationMs }) => {
      const io = (window as any).io;
      if (!io) throw new Error("socket.io-client failed to load (window.io missing)");

      const created = await fetch(`${apiBase}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, sessionName: `tab-${index}` }),
      }).then((r) => r.json());
      const sessionId: string = created.id;

      const socket = io(apiBase, { path: "/socket.io/", transports: ["websocket"], reconnection: false });
      (window as any).__multitabSocket = socket;

      let count = 0;
      let deltas = 0;
      let foreign = 0;
      let ordered = true;
      let prevSeq = 0;
      let firstTs = 0;
      let lastTs = 0;
      let sawStart = false;
      let sawEnd = false;
      let reportedTicks = -1;
      socket.on("session:event", (envelope: any) => {
        if (envelope.sessionId !== sessionId) { foreign += 1; return; }
        const now = Date.now();
        if (firstTs === 0) firstTs = now;
        lastTs = now;
        count += 1;
        if (typeof envelope.seq === "number") {
          if (envelope.seq <= prevSeq) ordered = false;
          prevSeq = envelope.seq;
        }
        const type = envelope.event?.type;
        if (type === "agent_start") sawStart = true;
        else if (type === "agent_end") {
          sawEnd = true;
          const body = envelope.event?.messages?.[0]?.content ?? "";
          const m = /burst complete: (\d+) ticks/.exec(String(body));
          if (m) reportedTicks = Number(m[1]);
        } else if (type === "message_update") deltas += 1;
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket connect timeout")), 5_000);
        socket.on("connect", () => { clearTimeout(timer); resolve(); });
        socket.on("connect_error", (e: any) => { clearTimeout(timer); reject(new Error(`connect_error: ${e?.message ?? e}`)); });
      });

      const ack = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("subscribe ack timeout")), 5_000);
        socket.emit("session:subscribe", { sessionId, fromSeq: null }, (a: any) => { clearTimeout(timer); resolve(a); });
      });
      if (!ack?.ok) throw new Error(`subscribe rejected: ${JSON.stringify(ack)}`);

      // Fire the sustained burst. Do NOT await — the POST stays in flight for
      // the whole 20s while events stream over the socket.
      void fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `@@burst ${intervalMs} ${durationMs}` }),
      }).catch(() => { /* page may close first; ignore */ });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for agent_end; count=${count} deltas=${deltas}`)), durationMs + 10_000);
        const check = setInterval(() => {
          if (sawEnd) { clearInterval(check); clearTimeout(timer); resolve(); }
        }, 50);
      });

      return {
        sessionId, count, deltas, reportedTicks, foreign, ordered,
        connected: socket.connected === true,
        sawStart, sawEnd, firstTs, lastTs,
      };
    }, { apiBase: API_BASE, cwd, index, intervalMs: BURST_INTERVAL_MS, durationMs: BURST_DURATION_MS }),
  ));

  // Per-tab diagnostics so the actual delivered/generated counts are visible.
  for (const r of results) {
    console.log(`[tab ${r.sessionId.slice(0, 8)}] generated=${r.reportedTicks} delivered=${r.deltas} spread=${r.lastTs - r.firstTs}ms ordered=${r.ordered} foreign=${r.foreign}`);
  }

  // Per-tab: full sustained stream, in order, no cross-talk, still connected.
  for (const r of results) {
    expect(r.connected, `tab ${r.sessionId} socket stayed connected`).toBe(true);
    expect(r.sawStart && r.sawEnd, `tab ${r.sessionId} saw agent_start..agent_end`).toBe(true);
    expect(r.foreign, `tab ${r.sessionId} cross-talk events`).toBe(0);
    expect(r.ordered, `tab ${r.sessionId} seq monotonic`).toBe(true);
    // ZERO LOSS: every delta the mock generated was delivered. The generated
    // count is a bit under EXPECTED_TICKS only because setTimeout drifts past
    // 50ms under 6 concurrent loops — that's fewer ticks PRODUCED, not dropped.
    expect(r.reportedTicks, `tab ${r.sessionId} produced a real burst`).toBeGreaterThan(0);
    expect(r.deltas, `tab ${r.sessionId} delivered every generated delta (no loss)`).toBe(r.reportedTicks);
    // Sanity: the burst really was substantial (most of the ~400 ticks).
    expect(r.reportedTicks, `tab ${r.sessionId} generated ~${EXPECTED_TICKS} ticks`).toBeGreaterThanOrEqual(Math.floor(EXPECTED_TICKS * 0.85));
    // Sustained over most of the 20s window, not buffered-then-flushed.
    expect(r.lastTs - r.firstTs, `tab ${r.sessionId} stream spread`).toBeGreaterThanOrEqual(BURST_DURATION_MS * 0.75);
  }

  // Distinct sessions — each tab really ran its own.
  expect(new Set(results.map((r) => r.sessionId)).size).toBe(TAB_COUNT);

  // Simultaneity: there is a window during which EVERY tab was actively
  // streaming. If the latest start precedes the earliest finish, all tabs'
  // active intervals overlap.
  const latestStart = Math.max(...results.map((r) => r.firstTs));
  const earliestEnd = Math.min(...results.map((r) => r.lastTs));
  expect(earliestEnd - latestStart, "all tabs streamed simultaneously (overlapping active windows)").toBeGreaterThanOrEqual(10_000);

  // Tidy up sockets before tearing down pages to avoid disconnect-time noise.
  await Promise.all(pages.map((page) => page.evaluate(() => {
    try { (window as any).__multitabSocket?.disconnect(); } catch { /* ignore */ }
  })));

  errors.forEach((tab, index) => {
    expect(tab.pageErrors, `tab ${index} uncaught exceptions`).toEqual([]);
    expect(tab.consoleErrors, `tab ${index} console errors`).toEqual([]);
  });

  await context.close();
});
