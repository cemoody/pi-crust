/**
 * Integration contract: the client-side multiplexed connection driving a REAL
 * socket.io-client against the REAL gateway (createHttpApiServer). RED until
 * createRealtimeConnection is implemented.
 *
 * This is the end-to-end proof that the client abstraction and the server
 * gateway agree on the wire: one socket, multiplexed sessions, live delivery.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRealtimeConnection, type RealtimeConnection, type RealtimeTransport } from "../../src/web/api/realtime-connection.js";
import { createRealtimeHarness, waitFor, type RealtimeHarness } from "../helpers/realtime-test-harness.js";

const harnesses: RealtimeHarness[] = [];
const conns: RealtimeConnection[] = [];
const rawSockets: any[] = [];

afterEach(async () => {
  for (const conn of conns.splice(0)) conn.dispose();
  for (const socket of rawSockets.splice(0)) { try { socket.disconnect(); } catch { /* ignore */ } }
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

/** Adapt a socket.io-client socket to the RealtimeTransport interface. */
async function socketIoTransport(baseUrl: string): Promise<RealtimeTransport> {
  const { io } = await import("socket.io-client") as any;
  const socket = io(baseUrl, { path: "/socket.io/", transports: ["websocket"], reconnection: false, autoConnect: false });
  rawSockets.push(socket);
  return {
    get connected() { return socket.connected === true; },
    connect() { socket.connect(); },
    disconnect() { socket.disconnect(); },
    on(event, handler) { socket.on(event, handler); },
    off(event, handler) { socket.off(event, handler); },
    emit(event, payload, ack) { ack ? socket.emit(event, payload, ack) : socket.emit(event, payload); },
  };
}

describe("client realtime connection ↔ real gateway", () => {
  it("multiplexes two live sessions over one real socket and routes events", async () => {
    const harness = await setup();
    const one = await harness.createSession({ id: "one" });
    const two = await harness.createSession({ id: "two" });

    const transport = await socketIoTransport(harness.baseUrl);
    const conn = track(createRealtimeConnection({ transportFactory: () => transport, tabId: "tab-1" }));

    const onsOne: unknown[] = [];
    const onsTwo: unknown[] = [];
    // fromSeq:0 so events emitted before the async socket finishes connecting
    // are replayed from the server ring (rather than lost as live-only).
    conn.subscribe(one.id, (e) => onsOne.push(e), { fromSeq: 0 });
    conn.subscribe(two.id, (e) => onsTwo.push(e), { fromSeq: 0 });

    one.emitTestEvent({ type: "agent_start" });
    two.emitTestEvent({ type: "agent_start" });

    await waitFor(() => (onsOne.length > 0 && onsTwo.length > 0 ? true : undefined));
    expect(onsOne).toContainEqual(expect.objectContaining({ type: "agent_start" }));
    expect(onsTwo).toContainEqual(expect.objectContaining({ type: "agent_start" }));
    expect(conn.connectionCount).toBe(1);

    // The server confirms the multiplexing: two sessions, ONE physical socket.
    const stats = await fetch(`${harness.baseUrl}/api/realtime/stats`).then((r) => r.json());
    expect(stats).toMatchObject({ connections: 1 });
  });
});

async function setup(): Promise<RealtimeHarness> {
  const harness = await createRealtimeHarness();
  harnesses.push(harness);
  return harness;
}

function track(c: RealtimeConnection): RealtimeConnection { conns.push(c); return c; }
