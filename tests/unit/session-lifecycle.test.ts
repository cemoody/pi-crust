import { describe, expect, it, vi } from "vitest";
import type { PiEvent, PiSessionHandle } from "../../src/server/pi/types.js";
import { SessionLifecycle } from "../../src/server/session/lifecycle/session-lifecycle.js";

function handle(id: string) {
  const subscribers = new Set<(event: PiEvent, seq: number) => void>();
  return {
    id,
    cwd: "/project",
    sessionFile: `/sessions/${id}.jsonl`,
    subscribeWithSeq(listener: (event: PiEvent, seq: number) => void) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    emit(event: PiEvent, seq: number) {
      for (const listener of subscribers) listener(event, seq);
    },
  } as unknown as PiSessionHandle & { emit(event: PiEvent, seq: number): void };
}

describe("SessionLifecycle contract", () => {
  it("owns replay, lifecycle observers, and subscriber transfer across a replacement handle", () => {
    const observed = vi.fn();
    const lifecycle = new SessionLifecycle({ eventRingSize: 2, onEvent: observed });
    const original = handle("original");
    lifecycle.attach(original);

    const delivered: Array<{ type: string; seq: number }> = [];
    lifecycle.subscribeWithSeq(original.id, (event, seq) => delivered.push({ type: event.type, seq }));
    original.emit({ type: "agent_start" }, 7);

    const replacement = handle("replacement");
    lifecycle.replace(original.id, replacement);
    replacement.emit({ type: "agent_end", messages: [] }, 1);

    expect(lifecycle.has(original.id)).toBe(false);
    expect(lifecycle.get(replacement.id).handle).toBe(replacement);
    expect(delivered).toEqual([{ type: "agent_start", seq: 7 }, { type: "agent_end", seq: 1 }]);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(lifecycle.lastSeq(replacement.id)).toBe(1);
  });

  it("closes realtime delivery before forgetting a handle", () => {
    const lifecycle = new SessionLifecycle({ eventRingSize: 2 });
    const session = handle("close-me");
    lifecycle.attach(session);
    const listener = vi.fn();
    lifecycle.subscribe(session.id, listener);

    lifecycle.closeEvents(session.id);
    session.emit({ type: "agent_start" }, 1);
    expect(listener).not.toHaveBeenCalled();
    expect(lifecycle.get(session.id).handle).toBe(session);

    lifecycle.forget(session.id);
    expect(lifecycle.has(session.id)).toBe(false);
    expect(() => lifecycle.get(session.id)).toThrow("Unknown session: close-me");
  });
});
