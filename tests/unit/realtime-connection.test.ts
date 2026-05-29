/**
 * TDD contract for the client-side multiplexed realtime connection
 * (src/web/api/realtime-connection.ts). RED until implemented.
 *
 * Covers the single-tab story:
 *   - many session subscriptions share ONE transport (multiplexing)
 *   - events route to the right per-session listener; envelopes are unwrapped
 *   - ref-counted subscribe/unsubscribe + session:unsubscribe on the wire
 *   - idle transport teardown
 *   - reconnect → re-subscribe each session from its last seen seq, with a
 *     synthetic stream_reconnected marker (parity with the EventSource path)
 *   - session_resync passthrough
 *   - page-visibility pause/resume
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeConnection, type RealtimeConnection } from "../../src/web/api/realtime-connection.js";
import { FakeTransport, FakeVisibility, flushMicrotasks } from "../helpers/realtime-client-harness.js";

const conns: RealtimeConnection[] = [];
function track(c: RealtimeConnection): RealtimeConnection { conns.push(c); return c; }
afterEach(() => { for (const c of conns.splice(0)) c.dispose(); });

describe("client realtime connection — single-tab multiplexing", () => {
  it("opens exactly one transport for many session subscriptions", () => {
    const transport = new FakeTransport();
    const conn = track(createRealtimeConnection({ transportFactory: () => transport }));

    conn.subscribe("s1", () => {});
    conn.subscribe("s2", () => {});
    conn.subscribe("s3", () => {});
    transport.simulateConnect();

    expect(conn.connectionCount).toBe(1);
    expect(conn.activeSubscriptions).toBe(3);
    expect(transport.emitsOf("session:subscribe").map((m) => (m.payload as any).sessionId).sort())
      .toEqual(["s1", "s2", "s3"]);
  });

  it("routes events to the matching listener and unwraps the envelope", () => {
    const transport = new FakeTransport();
    const conn = track(createRealtimeConnection({ transportFactory: () => transport }));
    const s1: unknown[] = [];
    const s2: unknown[] = [];
    conn.subscribe("s1", (e) => s1.push(e));
    conn.subscribe("s2", (e) => s2.push(e));
    transport.simulateConnect();

    transport.simulateSessionEvent("s1", 1, { type: "agent_start" });
    transport.simulateSessionEvent("s2", 1, { type: "agent_start" });
    transport.simulateSessionEvent("s1", 2, { type: "agent_end", messages: [] });

    expect(s1).toEqual([{ type: "agent_start" }, { type: "agent_end", messages: [] }]);
    expect(s2).toEqual([{ type: "agent_start" }]);
  });

  it("ref-counts: two subscribers to one session share a single wire subscription", () => {
    const transport = new FakeTransport();
    const conn = track(createRealtimeConnection({ transportFactory: () => transport }));
    const a = conn.subscribe("s1", () => {});
    const b = conn.subscribe("s1", () => {});
    transport.simulateConnect();

    expect(transport.emitsOf("session:subscribe").length).toBe(1);

    a(); // one local listener gone; wire subscription stays
    expect(transport.emitsOf("session:unsubscribe").length).toBe(0);
    b(); // last listener gone; now unsubscribe on the wire
    expect(transport.emitsOf("session:unsubscribe").map((m) => (m.payload as any).sessionId)).toEqual(["s1"]);
  });

  it("closes the idle transport after the last unsubscribe", () => {
    const transport = new FakeTransport();
    let nowMs = 0;
    const conn = track(createRealtimeConnection({
      transportFactory: () => transport,
      idleCloseMs: 1_000,
      now: () => nowMs,
    }));
    const off = conn.subscribe("s1", () => {});
    transport.simulateConnect();
    expect(conn.connectionCount).toBe(1);

    off();
    nowMs = 1_001;
    // The connection should tear down its idle transport once the grace passes.
    // Implementations may use a timer; expose connectionCount as the contract.
    expect(conn.activeSubscriptions).toBe(0);
    expect(transport.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(conn.connectionCount).toBe(0);
  });
});

describe("client realtime connection — reconnect / resume", () => {
  it("re-subscribes every session from its last seen seq after a reconnect", () => {
    const transport = new FakeTransport();
    const conn = track(createRealtimeConnection({ transportFactory: () => transport }));
    conn.subscribe("s1", () => {});
    conn.subscribe("s2", () => {});
    transport.simulateConnect();

    transport.simulateSessionEvent("s1", 7, { type: "message_update" });
    transport.simulateSessionEvent("s2", 3, { type: "message_update" });

    transport.simulateDisconnect();
    transport.simulateConnect();

    const resumed = Object.fromEntries(
      transport.emitsOf("session:subscribe")
        .slice(-2)
        .map((m) => [(m.payload as any).sessionId, (m.payload as any).fromSeq]),
    );
    expect(resumed).toEqual({ s1: 7, s2: 3 });
  });

  it("delivers a synthetic stream_reconnected marker to each session on resume", () => {
    const transport = new FakeTransport();
    const conn = track(createRealtimeConnection({ transportFactory: () => transport }));
    const seen: unknown[] = [];
    conn.subscribe("s1", (e) => seen.push(e));
    transport.simulateConnect();
    transport.simulateSessionEvent("s1", 1, { type: "agent_start" });

    transport.simulateDisconnect();
    transport.simulateConnect();

    expect(seen).toContainEqual(expect.objectContaining({ type: "stream_reconnected" }));
  });

  it("passes a server session_resync marker through to the listener", () => {
    const transport = new FakeTransport();
    const conn = track(createRealtimeConnection({ transportFactory: () => transport }));
    const seen: unknown[] = [];
    conn.subscribe("s1", (e) => seen.push(e));
    transport.simulateConnect();

    transport.simulateSessionEvent("s1", 5, { type: "session_resync", fromSeq: 0, ringLowSeq: 3, lastSeq: 5 });
    expect(seen).toContainEqual(expect.objectContaining({ type: "session_resync" }));
  });

  it("drops events at or below the last delivered seq across a reconnect (no double-delivery)", () => {
    const transport = new FakeTransport();
    const conn = track(createRealtimeConnection({ transportFactory: () => transport }));
    const seen: any[] = [];
    conn.subscribe("s1", (e) => seen.push(e));
    transport.simulateConnect();
    transport.simulateSessionEvent("s1", 6, { type: "m", n: 6 });
    transport.simulateSessionEvent("s1", 7, { type: "m", n: 7 });

    transport.simulateDisconnect();
    transport.simulateConnect();
    // The server (or a race) redelivers seq 7 before sending 8.
    transport.simulateSessionEvent("s1", 7, { type: "m", n: 7 });
    transport.simulateSessionEvent("s1", 8, { type: "m", n: 8 });

    expect(seen.filter((e) => e.type === "m").map((e) => e.n)).toEqual([6, 7, 8]);
  });
});

describe("client realtime connection — failure modes", () => {
  it("surfaces an unknown-session subscribe rejection via telemetry without throwing", () => {
    const transport = new FakeTransport();
    transport.ackOkDefault = false;
    const events: any[] = [];
    const conn = track(createRealtimeConnection({
      transportFactory: () => transport,
      onClientEvent: (e) => events.push(e),
    }));
    conn.subscribe("missing", () => {});
    transport.simulateConnect();

    expect(events.some((e) => e.kind === "realtime-subscribe-rejected" && e.sessionId === "missing")).toBe(true);
    expect(transport.connected).toBe(true);
  });

  it("falls back after N consecutive connect errors, and a connect resets the count", () => {
    const transport = new FakeTransport();
    const fellBack: string[] = [];
    const conn = track(createRealtimeConnection({
      transportFactory: () => transport,
      maxConnectErrorsBeforeFallback: 3,
      onFallback: (reason) => fellBack.push(reason),
    }));
    conn.subscribe("s1", () => {});

    transport.simulateConnectError();
    transport.simulateConnect(); // resets the consecutive-error count
    transport.simulateConnectError();
    transport.simulateConnectError();
    expect(fellBack).toEqual([]);
    transport.simulateConnectError();
    expect(fellBack.length).toBe(1);
  });

  it("stops retrying once fallback fires (sticky)", () => {
    const transport = new FakeTransport();
    const fellBack: string[] = [];
    const conn = track(createRealtimeConnection({
      transportFactory: () => transport,
      maxConnectErrorsBeforeFallback: 1,
      onFallback: (reason) => fellBack.push(reason),
    }));
    conn.subscribe("s1", () => {});
    const connectsBefore = transport.connectCalls;
    transport.simulateConnectError();
    transport.simulateConnectError();
    expect(fellBack.length).toBe(1); // fired once, not twice
    expect(transport.connectCalls).toBe(connectsBefore); // no further reconnect attempts
  });

  it("does not crash on a transport-level error event", () => {
    const transport = new FakeTransport();
    const events: any[] = [];
    const conn = track(createRealtimeConnection({ transportFactory: () => transport, onClientEvent: (e) => events.push(e) }));
    conn.subscribe("s1", () => {});
    transport.simulateConnect();
    expect(() => transport.simulateError(new Error("boom"))).not.toThrow();
  });

  it("does not leak an ack timer across a reconnect (single timeout, not two)", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.withholdAcks = true;
      const events: any[] = [];
      const conn = track(createRealtimeConnection({
        transportFactory: () => transport,
        ackTimeoutMs: 1_000,
        onClientEvent: (e) => events.push(e),
      }));
      conn.subscribe("s1", () => {});
      transport.simulateConnect();   // arms ack timer #1
      transport.simulateDisconnect();
      transport.simulateConnect();   // arms ack timer #2 (must cancel #1)
      await vi.advanceTimersByTimeAsync(1_200);
      expect(events.filter((e) => e.kind === "realtime-subscribe-timeout" && e.sessionId === "s1").length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a stream_unavailable marker to the listener when the server rejects the subscribe", () => {
    const transport = new FakeTransport();
    transport.ackOkDefault = false;
    const seen: any[] = [];
    const conn = track(createRealtimeConnection({ transportFactory: () => transport }));
    conn.subscribe("missing", (e) => seen.push(e));
    transport.simulateConnect();
    expect(seen).toContainEqual(expect.objectContaining({ type: "stream_unavailable" }));
  });

  it("logs a telemetry event when a subscribe ack never arrives", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.withholdAcks = true;
      const events: any[] = [];
      const conn = track(createRealtimeConnection({
        transportFactory: () => transport,
        ackTimeoutMs: 1_000,
        onClientEvent: (e) => events.push(e),
      }));
      conn.subscribe("s1", () => {});
      transport.simulateConnect();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(events.some((e) => e.kind === "realtime-subscribe-timeout" && e.sessionId === "s1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("client realtime connection — page visibility", () => {
  it("pauses the transport when hidden and resumes (with resubscribe) when visible", async () => {
    const transport = new FakeTransport();
    const visibility = new FakeVisibility();
    const conn = track(createRealtimeConnection({ transportFactory: () => transport, visibility }));
    conn.subscribe("s1", () => {});
    transport.simulateConnect();
    transport.simulateSessionEvent("s1", 4, { type: "message_update" });

    visibility.set(false);
    await flushMicrotasks();
    expect(transport.connected).toBe(false);

    visibility.set(true);
    await flushMicrotasks();
    transport.simulateConnect();
    // On resume it must resubscribe s1 from seq 4.
    const last = transport.lastEmit("session:subscribe");
    expect(last?.payload).toMatchObject({ sessionId: "s1", fromSeq: 4 });
  });
});
