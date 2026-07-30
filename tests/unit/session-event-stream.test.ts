import { describe, expect, it, vi } from "vitest";
import type { PiEvent, PiEventListener, PiSessionHandle, SeqEventListener } from "../../src/server/pi/types.js";
import { SessionEventStream } from "../../src/server/session/session-event-stream.js";

function createHandle(withSequence = true) {
  let listener: PiEventListener | SeqEventListener | undefined;
  const unsubscribe = vi.fn();
  const handle = {
    id: "session-1",
    cwd: "/project",
    sessionFile: "/sessions/session-1.jsonl",
    getState: async () => ({ id: "session-1", cwd: "/project", sessionFile: "/sessions/session-1.jsonl", status: "idle" as const, messageCount: 0, lastActivity: 0 }),
    getMessages: async () => [],
    prompt: async () => undefined,
    abort: async () => undefined,
    setSessionName: async () => ({ id: "session-1", cwd: "/project", sessionFile: "/sessions/session-1.jsonl", status: "idle" as const, messageCount: 0, lastActivity: 0 }),
    setModel: async () => ({ id: "session-1", cwd: "/project", sessionFile: "/sessions/session-1.jsonl", status: "idle" as const, messageCount: 0, lastActivity: 0 }),
    subscribe: (next: PiEventListener) => { listener = next; return unsubscribe; },
    ...(withSequence ? { subscribeWithSeq: (next: SeqEventListener) => { listener = next; return unsubscribe; } } : {}),
    dispose: async () => undefined,
  } satisfies PiSessionHandle;
  return {
    handle,
    unsubscribe,
    emit(event: PiEvent, seq?: number) {
      if (seq === undefined) (listener as PiEventListener)(event);
      else (listener as SeqEventListener)(event, seq);
    },
  };
}

describe("SessionEventStream", () => {
  it("replays retained events and emits a resync marker before truncated history", () => {
    const source = createHandle();
    const stream = new SessionEventStream({ handle: source.handle, ringSize: 2 });
    source.emit({ type: "agent_start" } as PiEvent, 1);
    source.emit({ type: "agent_end" } as PiEvent, 2);
    source.emit({ type: "agent_start" } as PiEvent, 3);
    const received: Array<{ type: string; seq: number }> = [];

    stream.subscribeFromSeq(0, (event, seq) => received.push({ type: event.type, seq }));

    expect(received).toEqual([
      { type: "session_resync", seq: 3 },
      { type: "agent_end", seq: 2 },
      { type: "agent_start", seq: 3 },
    ]);
    expect(stream.lastSeq).toBe(3);
  });

  it("assigns local sequence numbers and isolates listener errors", () => {
    const source = createHandle(false);
    const stream = new SessionEventStream({ handle: source.handle, ringSize: 2 });
    const received: number[] = [];
    stream.subscribe(() => { throw new Error("consumer failure"); });
    stream.subscribe((_event, seq) => received.push(seq));

    source.emit({ type: "agent_start" } as PiEvent);
    source.emit({ type: "agent_end" } as PiEvent);

    expect(received).toEqual([1, 2]);
    expect(stream.subscriberCount).toBe(2);
    stream.close();
    expect(stream.subscriberCount).toBe(0);
    expect(source.unsubscribe).toHaveBeenCalledOnce();
  });
});
