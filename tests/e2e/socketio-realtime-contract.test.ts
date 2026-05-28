/**
 * TDD contract for the Socket.IO realtime transport.
 *
 * These tests intentionally describe the new surface before implementation.
 * They should be RED until pi-crust wires a Socket.IO server into the existing
 * HTTP API server. The invariant under test is that REST stays REST while live
 * session events move to one multiplexed Socket.IO connection.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRealtimeHarness, deferred, type RealtimeHarness } from "../helpers/realtime-test-harness.js";

const harnesses: RealtimeHarness[] = [];
const sockets: any[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try { socket.disconnect(); } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
  }
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("Socket.IO realtime transport contract", () => {
  it("streams live session events while the REST prompt request is still in flight", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "streaming" });
    const gate = deferred<void>();
    session.gateNextPrompt(gate.promise);

    const socket = await connectRealtimeSocket(harness.baseUrl);
    await subscribe(socket, session.id, null);

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

    const agentStart = await nextSessionEvent(socket, session.id, (event) => event.event?.type === "agent_start");
    expect(agentStart).toMatchObject({ sessionId: session.id, seq: 1, event: { type: "agent_start" } });
    expect(promptResolved).toBe(false);

    const delta = await nextSessionEvent(socket, session.id, (event) => event.event?.type === "message_update");
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

    const end = await nextSessionEvent(socket, session.id, (event) => event.event?.type === "agent_end");
    expect(end).toMatchObject({ sessionId: session.id, seq: 3, event: { type: "agent_end" } });
  });

  it("multiplexes multiple session subscriptions over one physical Socket.IO connection", async () => {
    const harness = await setup();
    const one = await harness.createSession({ id: "one" });
    const two = await harness.createSession({ id: "two" });
    const socket = await connectRealtimeSocket(harness.baseUrl);

    await subscribe(socket, one.id, null);
    await subscribe(socket, two.id, null);

    one.emitTestEvent({ type: "agent_start" });
    two.emitTestEvent({ type: "agent_start" });

    await expect(nextSessionEvent(socket, one.id)).resolves.toMatchObject({ sessionId: one.id, seq: 1, event: { type: "agent_start" } });
    await expect(nextSessionEvent(socket, two.id)).resolves.toMatchObject({ sessionId: two.id, seq: 1, event: { type: "agent_start" } });

    // A second logical session subscription must not require a second browser
    // transport. This is the core per-origin-connection-budget invariant.
    expect(socket.connected).toBe(true);
    expect(sockets.filter((candidate) => candidate.connected).length).toBe(1);
  });

  it("replays missed events by seq on subscribe", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "replay" });
    session.emitTestEvent({ type: "agent_start" });
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one" } } as any);
    session.emitTestEvent({ type: "agent_end", messages: [] } as any);

    const socket = await connectRealtimeSocket(harness.baseUrl);
    const ack = await subscribe(socket, session.id, 1);
    expect(ack).toMatchObject({ ok: true, sessionId: session.id, lastSeq: 3 });

    await expect(nextSessionEvent(socket, session.id)).resolves.toMatchObject({ sessionId: session.id, seq: 2 });
    await expect(nextSessionEvent(socket, session.id)).resolves.toMatchObject({ sessionId: session.id, seq: 3 });
  });

  it("emits a session_resync marker when fromSeq is older than the replay ring", async () => {
    const harness = await setup({ eventRingSize: 2 });
    const session = await harness.createSession({ id: "gap" });
    session.emitTestEvent({ type: "agent_start" });
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "kept-1" } } as any);
    session.emitTestEvent({ type: "agent_end", messages: [] } as any);

    const socket = await connectRealtimeSocket(harness.baseUrl);
    await subscribe(socket, session.id, 0);

    const resync = await nextSessionEvent(socket, session.id, (event) => event.event?.type === "session_resync");
    expect(resync).toMatchObject({
      sessionId: session.id,
      event: { type: "session_resync", fromSeq: 0, ringLowSeq: 2, lastSeq: 3 },
    });
    await expect(nextSessionEvent(socket, session.id, (event) => event.seq === 2)).resolves.toMatchObject({ sessionId: session.id, seq: 2 });
    await expect(nextSessionEvent(socket, session.id, (event) => event.seq === 3)).resolves.toMatchObject({ sessionId: session.id, seq: 3 });
  });

  it("unsubscribe stops future events for that logical subscription without closing the socket", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "unsub" });
    const socket = await connectRealtimeSocket(harness.baseUrl);
    await subscribe(socket, session.id, null);

    await unsubscribe(socket, session.id);
    session.emitTestEvent({ type: "agent_start" });

    await expect(noSessionEvent(socket, 250)).resolves.toBe(true);
    expect(socket.connected).toBe(true);
  });

  it("rejects unknown session subscriptions via ack and keeps the socket connected", async () => {
    const harness = await setup();
    const socket = await connectRealtimeSocket(harness.baseUrl);

    const ack = await subscribe(socket, "missing-session", null);
    expect(ack).toMatchObject({ ok: false, error: expect.stringMatching(/unknown session/i) });
    expect(socket.connected).toBe(true);
  });
});

async function setup(options: { readonly eventRingSize?: number } = {}): Promise<RealtimeHarness> {
  const harness = await createRealtimeHarness(options);
  harnesses.push(harness);
  return harness;
}

async function connectRealtimeSocket(baseUrl: string): Promise<any> {
  const { io } = await loadSocketIoClient();
  const socket = io(baseUrl, {
    path: "/socket.io/",
    transports: ["websocket"],
    reconnection: false,
    timeout: 1_000,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Socket.IO realtime transport")), 1_500);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", (error: unknown) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function loadSocketIoClient(): Promise<{ readonly io: any }> {
  try {
    return await import("socket.io-client") as any;
  } catch (error) {
    throw new Error(`Socket.IO realtime tests require the socket.io-client package. Add socket.io/socket.io-client when implementing Option B. Cause: ${String(error)}`);
  }
}

async function subscribe(socket: any, sessionId: string, fromSeq: number | null): Promise<any> {
  return await emitWithAck(socket, "session:subscribe", { sessionId, fromSeq });
}

async function unsubscribe(socket: any, sessionId: string): Promise<any> {
  return await emitWithAck(socket, "session:unsubscribe", { sessionId });
}

async function emitWithAck(socket: any, event: string, payload: unknown): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} ack`)), 1_000);
    socket.emit(event, payload, (ack: unknown) => { clearTimeout(timer); resolve(ack); });
  });
}

async function nextSessionEvent(socket: any, sessionId: string, predicate: (event: any) => boolean = () => true): Promise<any> {
  const deadline = Date.now() + 2_000;
  const queue: any[] = socket.__testEventQueue ??= [];
  for (;;) {
    const index = queue.findIndex((event) => event.sessionId === sessionId && predicate(event));
    if (index !== -1) return queue.splice(index, 1)[0];
    const event = await Promise.race([
      new Promise((resolve) => socket.once("session:event", resolve)),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(TIMEOUT), 50)),
    ]);
    if (event !== TIMEOUT) {
      if ((event as any).sessionId === sessionId && predicate(event)) return event;
      queue.push(event);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for session:event for ${sessionId}`);
  }
}

async function noSessionEvent(socket: any, timeoutMs: number): Promise<boolean> {
  const event = await Promise.race([
    new Promise((resolve) => socket.once("session:event", resolve)),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(TIMEOUT), timeoutMs)),
  ]);
  return event === TIMEOUT;
}

const TIMEOUT = Symbol("timeout");
