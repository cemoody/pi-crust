/**
 * TDD contract for the resilience + coexistence guarantees of the Socket.IO
 * realtime transport.
 *
 * Two distinct classes of expectation live here:
 *
 *  1. NEW SURFACE (should be RED until Option B is implemented):
 *     - A client that drops its transport and reconnects can resume from the
 *       last seq it saw and receive every event it missed while offline. This
 *       is the whole point of moving off raw EventSource/ws: reconnect +
 *       missed-event recovery as a first-class concept.
 *     - The realtime gateway never double-delivers an event the client
 *       already acked via fromSeq.
 *
 *  2. INVARIANTS (should stay GREEN — REST stays REST):
 *     - Mounting the realtime gateway on the shared http.Server must not
 *       shadow or break the existing JSON REST routes.
 *     - The legacy SSE event stream must keep working on the same server, so
 *       Socket.IO is additive and SSE remains a fallback transport.
 *
 * The invariants are written against the same harness the contract file uses.
 * They exercise plain REST/SSE over harness.baseUrl, so they pass today and
 * must keep passing after the gateway is wired in.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRealtimeHarness, type RealtimeHarness } from "../helpers/realtime-test-harness.js";

const harnesses: RealtimeHarness[] = [];
const sockets: any[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try { socket.disconnect(); } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
  }
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("Socket.IO realtime resilience (NEW surface — RED until implemented)", () => {
  it("resumes from last seq and replays only missed events after a reconnect", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "reconnect" });

    const first = await connectRealtimeSocket(harness.baseUrl);
    await subscribe(first, session.id, null);

    session.emitTestEvent({ type: "agent_start" });
    const e1 = await nextSessionEvent(first, session.id);
    expect(e1).toMatchObject({ seq: 1 });

    // Simulate a transport drop. While the client is gone, the server keeps
    // buffering events in the per-session ring.
    first.disconnect();
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "while-offline-1" } } as any);
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "while-offline-2" } } as any);

    // New physical connection, resume from the last seq we saw (1).
    const second = await connectRealtimeSocket(harness.baseUrl);
    const ack = await subscribe(second, session.id, 1);
    expect(ack).toMatchObject({ ok: true, lastSeq: 3 });

    const replayed1 = await nextSessionEvent(second, session.id);
    const replayed2 = await nextSessionEvent(second, session.id);
    expect(replayed1).toMatchObject({ seq: 2, event: { assistantMessageEvent: { type: "text_delta", delta: "while-offline-1" } } });
    expect(replayed2).toMatchObject({ seq: 3, event: { assistantMessageEvent: { type: "text_delta", delta: "while-offline-2" } } });

    // No double-delivery of seq 1 (already acked before the drop).
    await expect(noSessionEventWithSeq(second, 1, 250)).resolves.toBe(true);
  });

  it("does not redeliver events at or below the resumed fromSeq", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "no-dup" });
    session.emitTestEvent({ type: "agent_start" });
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } } as any);
    session.emitTestEvent({ type: "agent_end", messages: [] } as any);

    const socket = await connectRealtimeSocket(harness.baseUrl);
    await subscribe(socket, session.id, 3);

    // fromSeq=3 == lastSeq, so there is nothing to replay.
    await expect(noSessionEvent(socket, 250)).resolves.toBe(true);
  });
});

describe("REST/SSE coexistence (INVARIANT — must stay GREEN)", () => {
  it("keeps serving JSON REST routes on the same server the gateway uses", async () => {
    const harness = await setup();
    await harness.createSession({ id: "rest-coexist" });

    const response = await fetch(`${harness.baseUrl}/api/sessions`);
    expect(response.ok).toBe(true);
    const body = await response.json();
    const ids = (Array.isArray(body) ? body : body.sessions ?? []).map((card: any) => card.id);
    expect(ids).toContain("rest-coexist");
  });

  it("keeps the legacy SSE stream working as a fallback transport", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "sse-fallback" });

    const controller = new AbortController();
    const response = await fetch(
      `${harness.baseUrl}/api/sessions/${encodeURIComponent(session.id)}/events`,
      { signal: controller.signal },
    );
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");

    const ready = await readFirstSseEvent(response);
    expect(ready).not.toBeNull();
    controller.abort();
  });

  it("does not let the /socket.io/ handshake path shadow /api routes", async () => {
    const harness = await setup();
    // A bogus /api path must still be handled by the REST router (404 JSON),
    // proving the realtime gateway only claims its own namespace.
    const response = await fetch(`${harness.baseUrl}/api/this-route-does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
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
    throw new Error(`Socket.IO realtime tests require the socket.io-client package. Cause: ${String(error)}`);
  }
}

async function subscribe(socket: any, sessionId: string, fromSeq: number | null): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for session:subscribe ack")), 1_000);
    socket.emit("session:subscribe", { sessionId, fromSeq }, (ack: unknown) => { clearTimeout(timer); resolve(ack); });
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

async function noSessionEventWithSeq(socket: any, seq: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await Promise.race([
      new Promise((resolve) => socket.once("session:event", resolve)),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(TIMEOUT), deadline - Date.now())),
    ]);
    if (event === TIMEOUT) return true;
    if ((event as any).seq === seq) return false;
  }
  return true;
}

async function readFirstSseEvent(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const sep = buffer.indexOf("\n\n");
    if (sep !== -1) return buffer.slice(0, sep);
    const chunk = await reader.read();
    if (chunk.done) return null;
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  return null;
}

const TIMEOUT = Symbol("timeout");
