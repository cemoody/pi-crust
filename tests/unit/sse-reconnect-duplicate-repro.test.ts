/**
 * End-to-end reproduction of the "messages get copied over on reconnect" bug.
 *
 * This wires the REAL pieces together so the test exercises the exact root
 * cause, not a hand-rolled approximation:
 *
 *   server SSE frames (id: <seq>)  ->  HttpSessionDashboardApi.streamEvents
 *   (the SSE transport)            ->  applyRealtimeEvent (the dashboard
 *                                      timeline reducer)
 *
 * The failure mechanism:
 *   1. The server tags every SSE frame with `id: <seq>`.
 *   2. The browser's NATIVE EventSource auto-reconnect transparently resumes
 *      via Last-Event-ID, so the server REPLAYS buffered frames the client has
 *      already seen (same payloads, same ids).
 *   3. Without seq dedup on the SSE path, those replays reach the reducer
 *      again. A replayed `message_end` used to mint a fresh Date.now() draft
 *      id and APPEND a second assistant row -> the duplicate the user saw,
 *      which only cleared on a full page reload.
 *
 * Both halves of the fix are required for this to pass:
 *   - SSE seq dedup in http-session-api.ts drops the replayed frames.
 *   - Stable, timestamp-keyed assistant rows in session-dashboard-realtime.ts
 *     make a replayed message_end idempotent even if a duplicate slips through.
 *
 * Reverting either fix makes the final assertion fail with two assistant rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { applyRealtimeEvent } from "../../src/web/components/session-dashboard-realtime.js";
import type { TimelineMessage } from "../../src/web/components/MessageTimeline.js";

// Force the legacy SSE (EventSource) transport; the bug lives there.
beforeEach(() => { vi.stubEnv("VITE_PI_CRUST_REALTIME", "sse"); });
afterEach(() => { vi.unstubAllEnvs(); });

interface SseFrame { readonly lastEventId: string; readonly data: string }

describe("SSE auto-reconnect replay does not duplicate messages (repro)", () => {
  let mockSource: { onmessage: ((ev: SseFrame) => void) | null; onopen: (() => void) | null; onerror: (() => void) | null; readyState: number; close: Mock };

  beforeEach(() => {
    mockSource = { onmessage: null, onopen: null, onerror: null, readyState: 1, close: vi.fn() };
    vi.stubGlobal("EventSource", class MockEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 1;
      onmessage: ((ev: SseFrame) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        // Defer wiring so the api has installed its handlers (mirrors the real
        // EventSource, which fires events on a later tick).
        setTimeout(() => { mockSource.onmessage = this.onmessage; this.onopen?.(); }, 0);
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("window", undefined);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("keeps a single assistant row when the server replays a completed turn", async () => {
    const sessionId = "sid-repro";
    // Dashboard-side timeline state, driven exactly like SessionDashboard does.
    let messagesBySession: Record<string, TimelineMessage[]> = {};
    const setMessagesBySession = (updater: Record<string, TimelineMessage[]> | ((c: Record<string, TimelineMessage[]>) => Record<string, TimelineMessage[]>)) => {
      messagesBySession = typeof updater === "function" ? updater(messagesBySession) : updater;
    };
    const streamDraftIds: Record<string, string> = {};

    const { HttpSessionDashboardApi } = await import("../../src/web/api/http-session-api.js");
    const api = new HttpSessionDashboardApi();
    const unsubscribe = api.streamEvents(sessionId, (event) => {
      // The dashboard ignores control markers (stream_reconnected etc.) for the
      // timeline reducer; replicate just the reducer hand-off here.
      applyRealtimeEvent(sessionId, event as Record<string, unknown>, setMessagesBySession, streamDraftIds);
    });
    await vi.advanceTimersByTimeAsync(1); // let onopen fire and wire onmessage

    // One streamed assistant turn. Timestamp is the same across start/end (the
    // turn's timestamp), which is what makes the row stable.
    const ts = 1_700_000_000_000;
    const turn: SseFrame[] = [
      { lastEventId: "1", data: JSON.stringify({ type: "message_start", message: { role: "assistant", content: "", timestamp: ts } }) },
      { lastEventId: "2", data: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } }) },
      { lastEventId: "3", data: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }) },
      { lastEventId: "4", data: JSON.stringify({ type: "message_end", message: { role: "assistant", content: "hello world", timestamp: ts } }) },
    ];
    for (const frame of turn) mockSource.onmessage?.(frame);

    // Sanity: the turn rendered as exactly one assistant row.
    expect((messagesBySession[sessionId] ?? []).filter((m) => m.role === "assistant")).toHaveLength(1);

    // Time passes before the reconnect (a real reconnect happens seconds after
    // the turn finished). Advancing fake timers also advances Date.now(), which
    // is essential: the OLD reducer keyed the streaming row by Date.now(), so a
    // replayed message_end at a LATER time minted a different id and appended a
    // duplicate. Freezing the clock (as the original tests did) hid the bug.
    await vi.advanceTimersByTimeAsync(5_000);

    // NATIVE auto-reconnect: the same EventSource resumes and the server
    // replays every buffered frame (identical ids + payloads). Before the fix
    // this appended a duplicate assistant row.
    for (const frame of turn) mockSource.onmessage?.(frame);

    const assistantRows = (messagesBySession[sessionId] ?? []).filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({ role: "assistant", text: "hello world" });

    unsubscribe();
  });
});
