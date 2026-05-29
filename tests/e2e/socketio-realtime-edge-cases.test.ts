/**
 * Edge-case contract for the Socket.IO realtime transport: cold-session open
 * parity, leak-free teardown, fromSeq semantics, ordering, large payloads,
 * consumer isolation, abort delivery.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  connectRealtimeSocket,
  createRealtimeHarness,
  waitFor,
  type RealtimeHarness,
  type RealtimeSocket,
} from "../helpers/realtime-test-harness.js";

const harnesses: RealtimeHarness[] = [];
const sockets: RealtimeSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) { socket.disconnect(); socket.close(); }
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("Socket.IO realtime edge cases", () => {
  it("opens a cold (disk-resident) session on subscribe — parity with the SSE route", async () => {
    const harness = await setup();
    const { id } = await harness.createSessionViaHttp();
    await harness.coolSession(id);
    expect(harness.registry.hasSession(id)).toBe(false);

    const socket = await connect(harness.baseUrl);
    const ack = await socket.subscribe(id, null);
    expect(ack).toMatchObject({ ok: true, sessionId: id });
    await waitFor(() => harness.registry.hasSession(id));
    harness.adapter.requireSession(id).emitTestEvent({ type: "agent_start" });
    await expect(socket.nextEvent(id)).resolves.toMatchObject({ sessionId: id, event: { type: "agent_start" } });
  });

  it("is idempotent: subscribing twice on one socket does not double-deliver", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "idem" });
    const socket = await connect(harness.baseUrl);

    await socket.subscribe(session.id, null);
    await socket.subscribe(session.id, null);

    session.emitTestEvent({ type: "agent_start" });

    expect(await socket.nextEvent(session.id)).toMatchObject({ seq: 1 });
    await expect(socket.noEventWithSeq(1, 250)).resolves.toBe(true);
    expect(harness.registry.subscriberCount(session.id)).toBe(1);
  });

  it("tears down the registry subscription when the socket disconnects (no leak)", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "leak" });
    const socket = await connect(harness.baseUrl);

    await socket.subscribe(session.id, null);
    expect(harness.registry.subscriberCount(session.id)).toBe(1);

    socket.disconnect();
    await waitFor(() => (harness.registry.subscriberCount(session.id) === 0 ? true : undefined));
    expect(harness.registry.subscriberCount(session.id)).toBe(0);
  });

  it("fromSeq=null subscribes live-only (no replay of buffered events)", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "live-only" });
    session.emitTestEvent({ type: "agent_start" });
    session.emitTestEvent({ type: "agent_end", messages: [] } as any);

    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, null);

    await expect(socket.noEvent(250)).resolves.toBe(true);
    session.emitTestEvent({ type: "agent_start" });
    await expect(socket.nextEvent(session.id)).resolves.toMatchObject({ seq: 3 });
  });

  it("fromSeq=0 replays the entire buffered backlog", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "replay-all" });
    session.emitTestEvent({ type: "agent_start" });
    session.emitTestEvent({ type: "agent_end", messages: [] } as any);

    const socket = await connect(harness.baseUrl);
    const ack = await socket.subscribe(session.id, 0);
    expect(ack).toMatchObject({ ok: true, lastSeq: 2 });
    await expect(socket.nextEvent(session.id, (e) => e.seq === 1)).resolves.toMatchObject({ seq: 1 });
    await expect(socket.nextEvent(session.id, (e) => e.seq === 2)).resolves.toMatchObject({ seq: 2 });
  });

  it("fromSeq ahead of the server's lastSeq forces a session_resync", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "ahead" });
    session.emitTestEvent({ type: "agent_start" });

    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, 99);
    const resync = await socket.nextEvent(session.id, (e) => e.event?.type === "session_resync");
    expect(resync).toMatchObject({ event: { type: "session_resync", fromSeq: 99, lastSeq: 1 } });
  });

  it("preserves strict seq ordering under a synchronous burst", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "burst" });
    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, null);

    for (let i = 0; i < 20; i += 1) {
      session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `d${i}` } } as any);
    }

    const seqs: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const event = await socket.nextEvent(session.id, (e) => !seqs.includes(e.seq));
      seqs.push(event.seq);
    }
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("delivers agent_end after abort", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "abort" });
    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, null);

    await fetch(`${harness.baseUrl}/api/sessions/${encodeURIComponent(session.id)}/abort`, { method: "POST" });

    await expect(socket.nextEvent(session.id, (e) => e.event?.type === "agent_end"))
      .resolves.toMatchObject({ event: { type: "agent_end" } });
  });

  it("delivers a large event payload intact (no truncation/backpressure loss)", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "large" });
    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, null);

    const big = "x".repeat(512 * 1024);
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: big } } as any);

    const event = await socket.nextEvent(session.id);
    expect(event.event.assistantMessageEvent.delta.length).toBe(big.length);
  });

  it("isolates subscriptions: a slow/idle session does not block another", async () => {
    const harness = await setup();
    const slow = await harness.createSession({ id: "slow" });
    const fast = await harness.createSession({ id: "fast" });
    const socket = await connect(harness.baseUrl);
    await socket.subscribe(slow.id, null);
    await socket.subscribe(fast.id, null);

    fast.emitTestEvent({ type: "agent_start" });
    await expect(socket.nextEvent(fast.id)).resolves.toMatchObject({ sessionId: fast.id, seq: 1 });
    expect(harness.registry.subscriberCount(slow.id)).toBe(1);
  });
});

async function setup(options: { readonly eventRingSize?: number } = {}): Promise<RealtimeHarness> {
  const harness = await createRealtimeHarness(options);
  harnesses.push(harness);
  return harness;
}

async function connect(baseUrl: string): Promise<RealtimeSocket> {
  const socket = await connectRealtimeSocket(baseUrl);
  sockets.push(socket);
  return socket;
}
