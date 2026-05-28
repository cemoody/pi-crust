/**
 * Multi-tab realtime acceptance test for the Socket.IO gateway.
 *
 * Opens several browser tabs against the same origin. Each tab:
 *   1. creates its own session,
 *   2. connects ONE multiplexed Socket.IO connection to the gateway,
 *   3. subscribes and fires a prompt,
 *   4. watches the agent_start … agent_end stream arrive live.
 *
 * Asserts every tab streamed its own session's events AND that no tab logged a
 * console error or threw an uncaught exception. This is the end-to-end proof of
 * the "many tabs, many connections" fragility fix: N tabs, N sessions, all
 * streaming, zero per-tab transport errors.
 */
import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "http://127.0.0.1:9787";
const TAB_COUNT = 6; // == Chrome's historical per-origin HTTP/1.1 budget.
const SOCKET_IO_CLIENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/socket.io-client/dist/socket.io.min.js",
);

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

test("N tabs each stream their own session over the Socket.IO gateway with no errors", async ({ browser }) => {
  // A shared context == multiple tabs in one browser, same origin/cookies.
  const context = await browser.newContext();

  // Discover an allowed cwd from the seeded session so per-tab createSession
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

  // Drive every tab concurrently: create a session, subscribe, prompt, and
  // collect the streamed event types until agent_end.
  const results = await Promise.all(pages.map((page, index) =>
    page.evaluate(async ({ apiBase, cwd, index }) => {
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

      const received: string[] = [];
      socket.on("session:event", (envelope: any) => {
        if (envelope.sessionId === sessionId && envelope.event?.type) received.push(envelope.event.type);
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

      await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `hello from tab ${index}` }),
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for agent_end; saw: ${received.join(",")}`)), 8_000);
        const check = setInterval(() => {
          if (received.includes("agent_end")) { clearInterval(check); clearTimeout(timer); resolve(); }
        }, 25);
      });

      const connected = socket.connected === true;
      return { sessionId, received, connected };
    }, { apiBase: API_BASE, cwd, index }),
  ));

  // Every tab streamed its OWN session lifecycle live over its single socket.
  for (const result of results) {
    expect(result.connected, `tab socket should stay connected for ${result.sessionId}`).toBe(true);
    expect(result.received, `tab ${result.sessionId} should see agent_start`).toContain("agent_start");
    expect(result.received, `tab ${result.sessionId} should see agent_end`).toContain("agent_end");
  }

  // All session ids are distinct — each tab really ran its own session.
  const ids = new Set(results.map((r) => r.sessionId));
  expect(ids.size).toBe(TAB_COUNT);

  // Clean up sockets before tearing down pages so we don't generate spurious
  // disconnect-time console noise.
  await Promise.all(pages.map((page) => page.evaluate(() => {
    try { (window as any).__multitabSocket?.disconnect(); } catch { /* ignore */ }
  })));

  // No tab logged an error or threw.
  errors.forEach((tab, index) => {
    expect(tab.pageErrors, `tab ${index} uncaught exceptions`).toEqual([]);
    expect(tab.consoleErrors, `tab ${index} console errors`).toEqual([]);
  });

  await context.close();
});
