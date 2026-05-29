/**
 * Resilience + coexistence contract for the Socket.IO realtime transport.
 *
 *  - NEW SURFACE: reconnect/resume by seq with no double-delivery.
 *  - INVARIANTS: REST stays REST and the legacy SSE stream keeps working on the
 *    same server.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  connectRealtimeSocket,
  createRealtimeHarness,
  type RealtimeHarness,
  type RealtimeSocket,
} from "../helpers/realtime-test-harness.js";

const harnesses: RealtimeHarness[] = [];
const sockets: RealtimeSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) { socket.disconnect(); socket.close(); }
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("Socket.IO realtime resilience (NEW surface)", () => {
  it("resumes from last seq and replays only missed events after a reconnect", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "reconnect" });

    const first = await connect(harness.baseUrl);
    await first.subscribe(session.id, null);

    session.emitTestEvent({ type: "agent_start" });
    expect(await first.nextEvent(session.id)).toMatchObject({ seq: 1 });

    // Transport drop. The server keeps buffering in the per-session ring.
    first.disconnect();
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "while-offline-1" } } as any);
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "while-offline-2" } } as any);

    const second = await connect(harness.baseUrl);
    const ack = await second.subscribe(session.id, 1);
    expect(ack).toMatchObject({ ok: true, lastSeq: 3 });

    expect(await second.nextEvent(session.id)).toMatchObject({ seq: 2, event: { assistantMessageEvent: { type: "text_delta", delta: "while-offline-1" } } });
    expect(await second.nextEvent(session.id)).toMatchObject({ seq: 3, event: { assistantMessageEvent: { type: "text_delta", delta: "while-offline-2" } } });
    await expect(second.noEventWithSeq(1, 250)).resolves.toBe(true);
  });

  it("does not redeliver events at or below the resumed fromSeq", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "no-dup" });
    session.emitTestEvent({ type: "agent_start" });
    session.emitTestEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } } as any);
    session.emitTestEvent({ type: "agent_end", messages: [] } as any);

    const socket = await connect(harness.baseUrl);
    await socket.subscribe(session.id, 3);
    await expect(socket.noEvent(250)).resolves.toBe(true);
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

async function connect(baseUrl: string): Promise<RealtimeSocket> {
  const socket = await connectRealtimeSocket(baseUrl);
  sockets.push(socket);
  return socket;
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
