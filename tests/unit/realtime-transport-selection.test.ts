/**
 * TDD contract for transport selection + SSE fallback (the rollback safety
 * net). RED until implemented.
 *
 *  - selectRealtimeTransport reads VITE_PI_CRUST_REALTIME, default "sse".
 *  - createStreamEvents satisfies the streamEvents contract for both transports.
 *  - the socketio path transparently + stickily falls back to SSE when the
 *    connection signals fallback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStreamEvents,
  selectRealtimeTransport,
  type StreamEvents,
} from "../../src/web/api/session-streamer.js";
import { createRealtimeConnection, type RealtimeConnection } from "../../src/web/api/realtime-connection.js";
import { FakeTransport } from "../helpers/realtime-client-harness.js";

const conns: RealtimeConnection[] = [];
afterEach(() => { for (const c of conns.splice(0)) c.dispose(); });

describe("selectRealtimeTransport", () => {
  it("defaults to socketio", () => {
    expect(selectRealtimeTransport({})).toBe("socketio");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "" })).toBe("socketio");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "nonsense" })).toBe("socketio");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "socketio" })).toBe("socketio");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "SocketIO" })).toBe("socketio");
  });

  it("opts out to sse only when explicitly requested", () => {
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "sse" })).toBe("sse");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "SSE" })).toBe("sse");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: " sse " })).toBe("sse");
  });
});

describe("createStreamEvents — contract parity", () => {
  it("the sse path delegates to the provided SSE streamer", () => {
    const calls: string[] = [];
    const sse: StreamEvents = (sessionId) => { calls.push(sessionId); return () => calls.push(`unsub:${sessionId}`); };
    const streamEvents = createStreamEvents({ transport: "sse", sse });

    const unsub = streamEvents("s1", () => {});
    expect(calls).toEqual(["s1"]);
    unsub();
    expect(calls).toEqual(["s1", "unsub:s1"]);
  });

  it("the socketio path subscribes via the multiplexed connection and delivers events", () => {
    const transport = new FakeTransport();
    const sse: StreamEvents = () => () => {};
    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      socketio: () => {
        const c = createRealtimeConnection({ transportFactory: () => transport });
        conns.push(c);
        return c;
      },
    });

    const seen: unknown[] = [];
    const unsub = streamEvents("s1", (e) => seen.push(e));
    transport.simulateConnect();
    transport.simulateSessionEvent("s1", 1, { type: "agent_start" });
    expect(seen).toContainEqual({ type: "agent_start" });
    unsub();
  });
});

describe("createStreamEvents — sticky SSE fallback", () => {
  it("switches a tab to SSE when the socketio connection signals fallback", () => {
    const transport = new FakeTransport();
    const sseCalls: string[] = [];
    const sse: StreamEvents = (sessionId) => { sseCalls.push(sessionId); return () => {}; };

    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      // maxConnectErrorsBeforeFallback=2 so two failures trip the fallback.
      socketio: () => {
        const c = createRealtimeConnection({
          transportFactory: () => transport,
          maxConnectErrorsBeforeFallback: 2,
        });
        conns.push(c);
        return c;
      },
    });

    streamEvents("s1", () => {});
    transport.simulateConnectError();
    transport.simulateConnectError(); // trips fallback

    // The session must now be (re)subscribed over SSE.
    expect(sseCalls).toContain("s1");

    // Sticky: a NEW subscription on the same tab goes straight to SSE.
    streamEvents("s2", () => {});
    expect(sseCalls).toContain("s2");
  });

  it("emits a reconnect marker to active listeners when Socket.IO falls back to SSE", () => {
    const transport = new FakeTransport();
    const sse: StreamEvents = () => () => {};
    const seen: unknown[] = [];

    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      socketio: () => {
        const c = createRealtimeConnection({
          transportFactory: () => transport,
          maxConnectErrorsBeforeFallback: 2,
        });
        conns.push(c);
        return c;
      },
    });

    streamEvents("s1", (event) => seen.push(event));
    transport.simulateConnectError();
    transport.simulateConnectError();

    // The handoff itself is a reconnect boundary. Anything emitted while the
    // socket was failing and before the SSE stream opened may be missing from
    // the live stream, so callers must see the same synthetic marker the SSE
    // reconnect path emits and refetch /messages.
    expect(seen).toContainEqual(expect.objectContaining({
      type: "stream_reconnected",
      reason: "socketio-fallback-connect-error-threshold",
    }));
  });

  it("emits one reconnect marker per active session when whole-tab fallback happens", () => {
    const transport = new FakeTransport();
    const sse: StreamEvents = () => () => {};
    const seenBySession: { s1: unknown[]; s2: unknown[] } = { s1: [], s2: [] };

    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      socketio: () => {
        const c = createRealtimeConnection({
          transportFactory: () => transport,
          maxConnectErrorsBeforeFallback: 1,
        });
        conns.push(c);
        return c;
      },
    });

    streamEvents("s1", (event) => seenBySession.s1.push(event));
    streamEvents("s2", (event) => seenBySession.s2.push(event));
    transport.simulateConnectError();

    for (const sessionId of ["s1", "s2"] as const) {
      expect(seenBySession[sessionId]).toContainEqual(expect.objectContaining({
        type: "stream_reconnected",
        reason: "socketio-fallback-connect-error-threshold",
      }));
    }
  });

  it("emits a reconnect marker when only one rejected session falls back to SSE", () => {
    const transport = new FakeTransport();
    transport.ackOkDefault = false;
    const sse: StreamEvents = () => () => {};
    const seen: unknown[] = [];

    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      socketio: () => {
        const c = createRealtimeConnection({ transportFactory: () => transport });
        conns.push(c);
        return c;
      },
    });

    streamEvents("missing", (event) => seen.push(event));
    transport.simulateConnect();

    expect(seen).toContainEqual(expect.objectContaining({
      type: "stream_reconnected",
      reason: "socketio-session-fallback-stream_unavailable",
    }));
  });

  it("emits exactly one reconnect marker per active session when fallback fires repeatedly", () => {
    const transport = new FakeTransport();
    const sse: StreamEvents = () => () => {};
    const seen: unknown[] = [];

    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      socketio: () => {
        const c = createRealtimeConnection({
          transportFactory: () => transport,
          maxConnectErrorsBeforeFallback: 1,
        });
        conns.push(c);
        return c;
      },
    });

    streamEvents("s1", (event) => seen.push(event));
    transport.simulateConnectError();
    transport.simulateConnectError();
    transport.simulateConnectError();

    expect(seen.filter((event) => (event as { type?: string }).type === "stream_reconnected")).toHaveLength(1);
  });

  it("unsubscribing after whole-tab fallback closes the SSE fallback stream", () => {
    const transport = new FakeTransport();
    const sseUnsub = vi.fn();
    const sse: StreamEvents = () => sseUnsub;

    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      socketio: () => {
        const c = createRealtimeConnection({
          transportFactory: () => transport,
          maxConnectErrorsBeforeFallback: 1,
        });
        conns.push(c);
        return c;
      },
    });

    const unsubscribe = streamEvents("s1", () => {});
    transport.simulateConnectError();
    unsubscribe();

    expect(sseUnsub).toHaveBeenCalledTimes(1);
    expect(transport.emitsOf("session:unsubscribe").filter((m) => (m.payload as any).sessionId === "s1")).toHaveLength(0);
  });

  it("unsubscribing after per-session fallback closes only that session's SSE fallback", () => {
    const transport = new FakeTransport();
    transport.ackOkDefault = false;
    const sseUnsubs: Record<string, ReturnType<typeof vi.fn>> = {};
    const sse: StreamEvents = (sessionId) => {
      const fn = vi.fn();
      sseUnsubs[sessionId] = fn;
      return fn;
    };

    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      socketio: () => {
        const c = createRealtimeConnection({ transportFactory: () => transport });
        conns.push(c);
        return c;
      },
    });

    const unsubscribe = streamEvents("missing", () => {});
    transport.simulateConnect();
    unsubscribe();

    expect(sseUnsubs.missing).toHaveBeenCalledTimes(1);
  });

  it("falls a SINGLE session back to SSE when its subscribe is rejected (socket stays up for others)", () => {
    const transport = new FakeTransport();
    transport.ackOkDefault = false; // server rejects every subscribe
    const sseCalls: string[] = [];
    const sse: StreamEvents = (sessionId) => { sseCalls.push(sessionId); return () => {}; };

    const streamEvents = createStreamEvents({
      transport: "socketio",
      sse,
      socketio: () => {
        const c = createRealtimeConnection({ transportFactory: () => transport });
        conns.push(c);
        return c;
      },
    });

    streamEvents("s1", () => {});
    transport.simulateConnect(); // subscribe rejected -> stream_unavailable
    expect(sseCalls).toContain("s1");
    // The socket is NOT torn down for the whole tab (per-session fallback).
    expect(transport.connected).toBe(true);
  });
});
