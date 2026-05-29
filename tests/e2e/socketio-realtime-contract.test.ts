/**
 * TDD contract for the Socket.IO realtime transport.
 *
 * Live session events move to one multiplexed Socket.IO connection while REST
 * stays REST. pi-crust keeps its own seq/ring/replay semantics.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  connectRealtimeSocket,
  createRealtimeHarness,
  deferred,
  type RealtimeHarness,
  type RealtimeSocket,
} from "../helpers/realtime-test-harness.js";

const harnesses: RealtimeHarness[] = [];
const sockets: RealtimeSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) { socket.disconnect(); socket.close(); }
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("Socket.IO realtime transport contract", () => {
  it("streams live session events while the REST prompt request is still in flight", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "streaming" });
    const gate = deferred<void>();
    session.gateNextPrompt(gate.promise);

    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, null);

    let promptResolved = false;
    const promptRequest = fetch(`${harness.baseUrl}/api/sessions/${encodeURIComponent(session.id)}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    }).then(async (response) => {
      promptResolved = true;
      expect(response.ok).toBe(true);
      return response.json();
    });

    const agentStart = await socket.nextEvent(session.id, (event) => event.event?.type === "agent_start");
    expect(agentStart).toMatchObject({ sessionId: session.id, seq: 1, event: { type: "agent_start" } });
    expect(promptResolved).toBe(false);

    const delta = await socket.nextEvent(session.id, (event) => event.event?.type === "message_update");
    expect(delta).toMatchObject({
      sessionId: session.id,
      seq: 2,
      event: { assistantMessageEvent: { type: "text_delta", delta: "delta:hello" } },
    });
    expect(promptResolved).toBe(false);

    gate.resolve();
    const messages = await promptRequest;
    expect(promptResolved).toBe(true);
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "done:hello" })]));

    const end = await socket.nextEvent(session.id, (event) => event.event?.type === "agent_end");
    expect(end).toMatchObject({ sessionId: session.id, seq: 3, event: { type: "agent_end" } });
  });

  it("multiplexes multiple session subscriptions over one physical Socket.IO connection", async () => {
    const harness = await setup();
    const one = await harness.createSession({ id: "one" });
    const two = await harness.createSession({ id: "two" });
    const socket = await connect(harness.baseUrl);

    await socket.subscribe(one.id, null);
    await socket.subscribe(two.id, null);

    one.emitTestEvent({ type: "agent_start" });
    two.emitTestEvent({ type: "agent_start" });

    await expect(socket.nextEvent(one.id)).resolves.toMatchObject({ sessionId: one.id, seq: 1, event: { type: "agent_start" } });
    await expect(socket.nextEvent(two.id)).resolves.toMatchObject({ sessionId: two.id, seq: 1, event: { type: "agent_start" } });

    // A second logical subscription must not require a second browser transport.
    expect(socket.socket.connected).toBe(true);
    expect(sockets.filter((candidate) => candidate.socket.connected).length).toBe(1);
  });

  it("replays missed events by seq on subscribe", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "replay" });
    session.emitTestEvent({ type: "agent_start" });
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one" } } as any);
    session.emitTestEvent({ type: "agent_end", messages: [] } as any);

    const socket = await connect(harness.baseUrl);
    const ack = await socket.subscribe(session.id, 1);
    expect(ack).toMatchObject({ ok: true, sessionId: session.id, lastSeq: 3 });

    await expect(socket.nextEvent(session.id)).resolves.toMatchObject({ sessionId: session.id, seq: 2 });
    await expect(socket.nextEvent(session.id)).resolves.toMatchObject({ sessionId: session.id, seq: 3 });
  });

  it("emits a session_resync marker when fromSeq is older than the replay ring", async () => {
    const harness = await setup({ eventRingSize: 2 });
    const session = await harness.createSession({ id: "gap" });
    session.emitTestEvent({ type: "agent_start" });
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "kept-1" } } as any);
    session.emitTestEvent({ type: "agent_end", messages: [] } as any);

    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, 0);

    const resync = await socket.nextEvent(session.id, (event) => event.event?.type === "session_resync");
    expect(resync).toMatchObject({
      sessionId: session.id,
      event: { type: "session_resync", fromSeq: 0, ringLowSeq: 2, lastSeq: 3 },
    });
    await expect(socket.nextEvent(session.id, (event) => event.seq === 2)).resolves.toMatchObject({ sessionId: session.id, seq: 2 });
    await expect(socket.nextEvent(session.id, (event) => event.seq === 3)).resolves.toMatchObject({ sessionId: session.id, seq: 3 });
  });

  it("unsubscribe stops future events for that logical subscription without closing the socket", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "unsub" });
    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, null);

    await socket.unsubscribe(session.id);
    session.emitTestEvent({ type: "agent_start" });

    await expect(socket.noEvent(250)).resolves.toBe(true);
    expect(socket.socket.connected).toBe(true);
  });

  it("rejects unknown session subscriptions via ack and keeps the socket connected", async () => {
    const harness = await setup();
    const socket = await connect(harness.baseUrl);

    const ack = await socket.subscribe("missing-session", null);
    expect(ack).toMatchObject({ ok: false, error: expect.stringMatching(/unknown session/i) });
    expect(socket.socket.connected).toBe(true);
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
