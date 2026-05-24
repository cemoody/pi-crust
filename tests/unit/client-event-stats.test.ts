/**
 * Tests for the in-memory client-event aggregator (PR-C of the
 * 2026-05-24 observability series).
 *
 * The aggregator is what backs GET /api/client-event/stats. It computes
 * histograms over an in-memory ring buffer of recent telemetry events
 * (kept in parallel with the on-disk client-events.jsonl) so the
 * dashboard can poll "what's been happening in the last 5 minutes?"
 * without re-reading a multi-MB file.
 *
 * We test the pure summarize function directly to pin its histogram
 * shape, then exercise the end-to-end flow via the HTTP endpoint in a
 * separate integration test.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { summarizeClientEventRing, CLIENT_EVENT_RING_CAPACITY } from "../../src/server/http-api-server.js";

type Slot = { ts: number; payload: Record<string, unknown> } | undefined;

function ringOf(events: Array<{ ts: number; payload: Record<string, unknown> }>): Slot[] {
  // Stable ordering doesn't matter for summarize; just put them in slots.
  const ring: Slot[] = new Array(CLIENT_EVENT_RING_CAPACITY);
  for (let i = 0; i < events.length; i++) ring[i] = events[i];
  return ring;
}

describe("summarizeClientEventRing", () => {
  afterEach(() => vi.useRealTimers());

  it("returns an empty histogram for an empty ring", () => {
    const stats = summarizeClientEventRing(ringOf([]), 60_000, 0);
    expect(stats).toEqual({
      windowMs: 60_000,
      total: 0,
      bufferDropped: 0,
      byKind: {},
      byApiErrorStatus: {},
      topSessions: [],
      topApiErrorPaths: [],
    });
  });

  it("filters out events older than the window", () => {
    vi.setSystemTime(new Date("2026-05-24T12:00:00Z"));
    const now = Date.now();
    const ring = ringOf([
      { ts: now - 10_000,  payload: { kind: "boot" } },               // in window
      { ts: now - 30_000,  payload: { kind: "boot" } },               // in window
      { ts: now - 120_000, payload: { kind: "boot" } },               // OUT (>60s)
    ]);
    const stats = summarizeClientEventRing(ring, 60_000, 3);
    expect(stats.total).toBe(2);
    expect(stats.byKind).toEqual({ boot: 2 });
  });

  it("counts api-error by status and surfaces top paths (2026-05-24 outage signature)", () => {
    vi.setSystemTime(new Date("2026-05-24T12:00:00Z"));
    const now = Date.now();
    // Simulate the 2026-05-24 outage: 13 sessions each hitting the same
    // /state and /messages endpoints with 500s. The aggregator should
    // surface "status:500 dominates" and "top paths" so an operator can
    // see "two endpoints x N sessions" without grepping the jsonl.
    const events: Array<{ ts: number; payload: Record<string, unknown> }> = [];
    for (let i = 0; i < 13; i++) {
      events.push({ ts: now - 1_000, payload: { kind: "api-error", status: 500, path: `/api/sessions/sid-${i}/state`, sessionId: `sid-${i}` } });
      events.push({ ts: now - 1_000, payload: { kind: "api-error", status: 500, path: `/api/sessions/sid-${i}/messages`, sessionId: `sid-${i}` } });
    }
    // One healthy session producing a 2xx-shape (no api-error).
    events.push({ ts: now - 1_000, payload: { kind: "boot", sessionId: "sid-healthy" } });
    // A handful of 404s to verify status histogram has multiple keys.
    for (let i = 0; i < 3; i++) {
      events.push({ ts: now - 1_000, payload: { kind: "api-error", status: 404, path: `/api/legacy/x-${i}`, sessionId: "sid-legacy" } });
    }
    const stats = summarizeClientEventRing(ringOf(events), 5 * 60_000, events.length);
    expect(stats.byKind["api-error"]).toBe(13 * 2 + 3);
    expect(stats.byApiErrorStatus).toEqual({ "500": 26, "404": 3 });
    // Top sessions: each of sid-0..sid-12 has 2 events, sid-legacy has 3, sid-healthy has 1.
    // So sid-legacy should be #1 with count 3.
    expect(stats.topSessions[0]).toEqual({ sessionId: "sid-legacy", count: 3 });
    // Top api-error paths cap at 5; should NOT include the boot or legacy paths first.
    expect(stats.topApiErrorPaths.length).toBe(5);
    expect(stats.topApiErrorPaths.every((p) => p.path.includes("/api/sessions/") || p.path.includes("/api/legacy/"))).toBe(true);
  });

  it("reports bufferDropped when more events have been appended than the ring capacity", () => {
    const stats = summarizeClientEventRing(ringOf([]), 60_000, CLIENT_EVENT_RING_CAPACITY + 17);
    expect(stats.bufferDropped).toBe(17);
  });

  it("does not crash on malformed events (no kind, no sessionId, no status)", () => {
    vi.setSystemTime(new Date("2026-05-24T12:00:00Z"));
    const ring = ringOf([
      { ts: Date.now() - 1, payload: {} as Record<string, unknown> },
      { ts: Date.now() - 1, payload: { kind: 123 } as unknown as Record<string, unknown> },
    ]);
    const stats = summarizeClientEventRing(ring, 60_000, 2);
    expect(stats.total).toBe(2);
    expect(stats.byKind["<unknown>"]).toBe(2);
  });
});
