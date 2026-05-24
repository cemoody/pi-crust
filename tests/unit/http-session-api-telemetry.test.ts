/**
 * Tests for the two client-side telemetry events added in PR-B:
 *
 *   1. `api-error` \u2014 emitted for every non-2xx response from the API
 *      wrapper. Pairs 1:1 with the server-side
 *      `pirpc.request.rejected_handle_closed` log from PR-A so the same
 *      symptom is visible on both ends.
 *
 *   2. `sse-silence` \u2014 emitted when an EventSource is open and the tab
 *      is visible but no message has arrived for N seconds. This catches
 *      the 2026-05-24 outage signature exactly: the SSE stream is
 *      *technically* connected (no `onerror` fires) but the server's
 *      in-memory session handle is closed, so no event ever flows.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  SSE_SILENCE_THRESHOLD_MS,
  SSE_SILENCE_CHECK_INTERVAL_MS,
} from "../../src/web/api/http-session-api.js";

// We have to import from the module under test AFTER stubbing globals,
// otherwise its top-level `recordClientEvent` import would not see the
// fetch mock. We do that inside each test below via dynamic import.

describe("api-error telemetry", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("emits an 'api-error' client event when fetch returns a non-2xx, then throws", async () => {
    // Mock fetch:
    //   - first call: the API request the client is making \u2014 returns 500
    //   - subsequent calls: the recordClientEvent POST to /api/client-event
    const apiBody = JSON.stringify({ error: "Pi RPC supervisor connection is closed" });
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/client-event")) {
        return new Response("{}", { status: 200 });
      }
      // The "real" request \u2014 simulate the closed-handle 500 from PR-A.
      return new Response(apiBody, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    // Telemetry helper checks for sessionStorage at module load via
    // getTabSessionId(); stub it so the import doesn't crash in node.
    vi.stubGlobal("window", undefined);

    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    await expect(api.getSession("sid-1")).rejects.toThrow(/supervisor connection is closed/);

    // Find the telemetry POST.
    const telemetryCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("/api/client-event"));
    expect(telemetryCall, "should have posted a telemetry event").toBeDefined();
    const body = JSON.parse(String((telemetryCall![1] as RequestInit).body));
    expect(body).toMatchObject({
      kind: "api-error",
      method: "GET",
      path: expect.stringContaining("/api/sessions/sid-1/state"),
      status: 500,
      errorPreview: expect.stringContaining("supervisor connection is closed"),
    });
    expect(typeof body.ageMs).toBe("number");
  });

  it("does NOT emit 'api-error' for a successful 2xx response", async () => {
    const fetchSpy: Mock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/api/client-event")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ id: "sid-2", title: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("window", undefined);

    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    await api.getSession("sid-2");

    const telemetry = fetchSpy.mock.calls
      .filter((c) => String(c[0]).includes("/api/client-event"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(telemetry.filter((e: { kind: string }) => e.kind === "api-error")).toEqual([]);
  });
});

describe("sse-silence telemetry threshold constants", () => {
  it("has reasonable defaults", () => {
    // 30 s threshold + 15 s check cadence: a real silence-bug session
    // produces its first warning within ~45 s of going silent. Smaller
    // values would mean false positives during normal lulls; larger
    // values would mean operators wait too long to notice.
    expect(SSE_SILENCE_THRESHOLD_MS).toBe(30_000);
    expect(SSE_SILENCE_CHECK_INTERVAL_MS).toBe(15_000);
  });
});

/**
 * End-to-end test for sse-silence with mock EventSource + fake timers.
 * Verifies the central failure mode from 2026-05-24:
 *   1. EventSource opens and reaches readyState=OPEN
 *   2. NO messages arrive for >30 s while document.visibilityState='visible'
 *   3. Client emits a single 'sse-silence' telemetry event
 *   4. If the silence persists, a second event fires after another threshold
 *   5. A backgrounded tab (visibilityState='hidden') does NOT emit silence
 */
describe("sse-silence detector behavior", () => {
  let mockSource: { readyState: number; close: Mock; onmessage: ((ev: { data: string }) => void) | null; onopen: (() => void) | null; onerror: (() => void) | null };
  let fetchSpy: Mock;

  beforeEach(() => {
    mockSource = {
      readyState: 1, // OPEN
      close: vi.fn(),
      onmessage: null,
      onopen: null,
      onerror: null,
    };
    vi.stubGlobal("EventSource", class MockEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 1;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        Object.defineProperty(this, "readyState", { get: () => mockSource.readyState, set: (v) => { mockSource.readyState = v; } });
        // Hook into the captured source so the test can fire onopen/onmessage on demand.
        setTimeout(() => {
          mockSource.onmessage = this.onmessage;
          mockSource.onopen = this.onopen;
          mockSource.onerror = this.onerror;
          // The wrapper's onopen fires when readyState becomes OPEN; simulate immediately.
          this.onopen?.();
        }, 0);
      }
    });
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("window", undefined);
    vi.useFakeTimers();
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("emits an sse-silence event after the threshold passes with no messages", async () => {
    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    const unsubscribe = api.streamEvents("sid-silence", () => {});

    // Let the constructor's microtask run so onopen fires.
    await vi.advanceTimersByTimeAsync(1);

    // No messages. Advance past the silence threshold.
    await vi.advanceTimersByTimeAsync(SSE_SILENCE_THRESHOLD_MS + SSE_SILENCE_CHECK_INTERVAL_MS);

    const silenceEvents = fetchSpy.mock.calls
      .filter((c) => String(c[0]).includes("/api/client-event"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
      .filter((e: { kind: string }) => e.kind === "sse-silence");

    expect(silenceEvents.length, `expected \u22651 sse-silence event. Got telemetry: ${JSON.stringify(fetchSpy.mock.calls.map((c) => c[1] && JSON.parse(String((c[1] as RequestInit).body))))}`)
      .toBeGreaterThanOrEqual(1);
    expect(silenceEvents[0]).toMatchObject({
      kind: "sse-silence",
      sessionId: "sid-silence",
      idleMs: expect.any(Number),
    });
    expect(silenceEvents[0].idleMs).toBeGreaterThanOrEqual(SSE_SILENCE_THRESHOLD_MS);

    unsubscribe();
  });

  it("does NOT emit sse-silence while the tab is hidden", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    const unsubscribe = api.streamEvents("sid-hidden", () => {});
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(SSE_SILENCE_THRESHOLD_MS * 3);

    const silenceEvents = fetchSpy.mock.calls
      .filter((c) => String(c[0]).includes("/api/client-event"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
      .filter((e: { kind: string }) => e.kind === "sse-silence");
    expect(silenceEvents).toEqual([]);
    unsubscribe();
  });

  it("a message resets the idle clock and suppresses the silence warning", async () => {
    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    const unsubscribe = api.streamEvents("sid-active", () => {});
    await vi.advanceTimersByTimeAsync(1);

    // Tick within the threshold, then deliver a message, then tick again to
    // just before the (post-message) threshold. No silence should fire.
    await vi.advanceTimersByTimeAsync(SSE_SILENCE_THRESHOLD_MS - 5_000);
    mockSource.onmessage?.({ data: JSON.stringify({ type: "agent_start" }) });
    await vi.advanceTimersByTimeAsync(SSE_SILENCE_THRESHOLD_MS - 5_000);

    const silenceEvents = fetchSpy.mock.calls
      .filter((c) => String(c[0]).includes("/api/client-event"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
      .filter((e: { kind: string }) => e.kind === "sse-silence");
    expect(silenceEvents).toEqual([]);
    unsubscribe();
  });
});

/**
 * Mobile-browser background-suspend regression.
 *
 * Repro: on iOS Safari / Android Chrome, when a tab is sent to the
 * background for many minutes (the user reports ~20m), the OS suspends
 * networking and the EventSource is terminated. When the user returns,
 * the page is still mounted with the same `streamEvents` subscription,
 * but no new events ever arrive because:
 *   (a) the EventSource is in readyState=CLOSED (browser gave up),
 *       and the browser does NOT auto-reconnect after suspend; OR
 *   (b) the EventSource is technically OPEN but the underlying TCP
 *       socket is dead (no data, no error fires).
 *
 * The expected behavior: the client SHOULD transparently re-establish
 * the SSE connection so the user sees streaming resume without having
 * to reload the tab.
 */
describe("mobile background reconnect (visibility change)", () => {
  let visibilityState: "visible" | "hidden";
  let visibilityListeners: Array<() => void>;
  let constructedSources: Array<{ url: string; readyState: number; close: Mock; onmessage: ((ev: { data: string }) => void) | null; onopen: (() => void) | null; onerror: (() => void) | null }>;
  let fetchSpy: Mock;

  beforeEach(() => {
    visibilityState = "visible";
    visibilityListeners = [];
    constructedSources = [];

    vi.stubGlobal("EventSource", class MockEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      url: string;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _state = 1;
      get readyState() { return this._state; }
      set readyState(v: number) { this._state = v; }
      close = vi.fn(() => { this._state = 2; });
      constructor(url: string) {
        this.url = url;
        const self = this;
        constructedSources.push({
          get url() { return self.url; },
          get readyState() { return self.readyState; },
          set readyState(v: number) { self.readyState = v; },
          close: self.close,
          get onmessage() { return self.onmessage; },
          set onmessage(v) { self.onmessage = v; },
          get onopen() { return self.onopen; },
          set onopen(v) { self.onopen = v; },
          get onerror() { return self.onerror; },
          set onerror(v) { self.onerror = v; },
        } as never);
        setTimeout(() => { this.onopen?.(); }, 0);
      }
    });

    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    vi.stubGlobal("document", {
      get visibilityState() { return visibilityState; },
      addEventListener: (event: string, fn: () => void) => {
        if (event === "visibilitychange") visibilityListeners.push(fn);
      },
      removeEventListener: (event: string, fn: () => void) => {
        if (event === "visibilitychange") {
          visibilityListeners = visibilityListeners.filter((listener) => listener !== fn);
        }
      },
    });
    vi.stubGlobal("window", undefined);
    vi.useFakeTimers();
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function dispatchVisibilityChange(state: "visible" | "hidden") {
    visibilityState = state;
    for (const listener of [...visibilityListeners]) listener();
  }

  it("reconnects the EventSource when the tab returns from background after the browser closed the stream (the 20-minute mobile bug)", async () => {
    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    const unsubscribe = api.streamEvents("sid-mobile", () => {});
    await vi.advanceTimersByTimeAsync(1);

    expect(constructedSources.length, "initial connect").toBe(1);

    // User backgrounds the tab on their phone.
    dispatchVisibilityChange("hidden");

    // ~20 minutes elapse. The mobile browser closes the SSE silently:
    // readyState flips to CLOSED but onerror is NOT delivered to the page
    // (it was suspended). No silence telemetry fires because the tab is
    // hidden.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    constructedSources[0]!.readyState = 2; // CLOSED

    // User taps the tab again.
    dispatchVisibilityChange("visible");
    await vi.advanceTimersByTimeAsync(1);

    expect(
      constructedSources.length,
      "client should have transparently reconnected the SSE so streaming resumes without a page reload",
    ).toBeGreaterThanOrEqual(2);

    // And the new EventSource should be pointed at the same session.
    expect(constructedSources[1]!.url).toContain("/api/sessions/sid-mobile/events");

    unsubscribe();
  });

  it("reconnects when the tab returns from background even if readyState still says OPEN but no data has flowed for a long time", async () => {
    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    const unsubscribe = api.streamEvents("sid-stale", () => {});
    await vi.advanceTimersByTimeAsync(1);

    expect(constructedSources.length).toBe(1);

    dispatchVisibilityChange("hidden");
    // 20 min in the background, no messages, readyState still OPEN.
    // (This is the iOS "zombie socket" pattern.)
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    dispatchVisibilityChange("visible");
    await vi.advanceTimersByTimeAsync(1);

    expect(
      constructedSources.length,
      "a long-silent stream should be re-established on foreground",
    ).toBeGreaterThanOrEqual(2);

    unsubscribe();
  });

  it("does not reconnect on visibilitychange if the stream is healthy (recent messages, OPEN)", async () => {
    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    const unsubscribe = api.streamEvents("sid-healthy", () => {});
    await vi.advanceTimersByTimeAsync(1);

    // A message arrives, then 5 s of normal idleness, then user briefly
    // switches tabs and comes right back.
    constructedSources[0]!.onmessage?.({ data: JSON.stringify({ type: "agent_start" }) });
    await vi.advanceTimersByTimeAsync(5_000);
    dispatchVisibilityChange("hidden");
    await vi.advanceTimersByTimeAsync(2_000);
    dispatchVisibilityChange("visible");
    await vi.advanceTimersByTimeAsync(1);

    expect(
      constructedSources.length,
      "a healthy stream must not be torn down on every quick visibility flip",
    ).toBe(1);

    unsubscribe();
  });
});


