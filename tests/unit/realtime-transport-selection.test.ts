/**
 * TDD contract for transport selection + SSE fallback (the rollback safety
 * net). RED until implemented.
 *
 *  - selectRealtimeTransport reads VITE_PI_CRUST_REALTIME, default "sse".
 *  - createStreamEvents satisfies the streamEvents contract for both transports.
 *  - the socketio path transparently + stickily falls back to SSE when the
 *    connection signals fallback.
 */
import { afterEach, describe, expect, it } from "vitest";
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
  it("defaults to sse", () => {
    expect(selectRealtimeTransport({})).toBe("sse");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "" })).toBe("sse");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "nonsense" })).toBe("sse");
  });

  it("selects socketio only when explicitly enabled", () => {
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "socketio" })).toBe("socketio");
    expect(selectRealtimeTransport({ VITE_PI_CRUST_REALTIME: "SocketIO" })).toBe("socketio");
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
