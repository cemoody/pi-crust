import { describe, it, expect } from "vitest";
import { applyRealtimeEvent } from "../../src/web/components/session-dashboard-realtime.js";
import type { TimelineMessage } from "../../src/web/components/MessageTimeline.js";

// Reproduces the "duplicate assistant rows in the live stream that vanish on
// reload" bug. The live reducer keys rows by client-derived ids, so the same
// logical turn rendered under two different ids becomes two rows. A full page
// reload rebuilds from the canonical server transcript and shows one.
//
// Tiny harness mimicking the dashboard's setMessagesBySession + draft-id ref.
function makeStore(sessionId: string) {
  let state: Record<string, TimelineMessage[]> = { [sessionId]: [] };
  const draftIds: Record<string, string> = {};
  const set: import("react").Dispatch<import("react").SetStateAction<Record<string, TimelineMessage[]>>> = (updater) => {
    state = typeof updater === "function" ? updater(state) : updater;
  };
  const feed = (event: Record<string, unknown>) => applyRealtimeEvent(sessionId, event, set, draftIds);
  const rows = () => state[sessionId] ?? [];
  return { feed, rows, draftIds };
}

const SID = "sess-1";
const assistantMsg = (ts: number, text: string) => ({
  role: "assistant",
  timestamp: ts,
  content: [{ type: "text", text }],
});

describe("live duplicate assistant rows (heals on reload)", () => {
  it("PATH A: replayed message_end after agent_end with a DIFFERENT timestamp stays idempotent", () => {
    const s = makeStore(SID);
    // Live turn streams normally with timestamp T1.
    s.feed({ type: "message_start", message: assistantMsg(1000, "") });
    s.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello world" } });
    s.feed({ type: "message_end", message: assistantMsg(1000, "Hello world") });
    s.feed({ type: "agent_end" }); // dashboard deletes the draft id here

    expect(s.rows().length).toBe(1);

    // SSE reconnect replays the finalize, but the persisted message carries a
    // slightly different finalize timestamp than the streaming start used.
    // This must NOT create a second row.
    s.feed({ type: "message_end", message: assistantMsg(1001, "Hello world") });

    expect(s.rows().length).toBe(1);
    expect(s.rows().every((r) => r.text === "Hello world")).toBe(true);
  });

  it("PATH B: joined mid-stream (no message_start) then replayed finalize stays idempotent", () => {
    const s = makeStore(SID);
    // We subscribed mid-turn: first event we see is a text_delta.
    s.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial answer" } });
    s.feed({ type: "message_end", message: assistantMsg(2000, "partial answer") });
    s.feed({ type: "agent_end" });

    expect(s.rows().length).toBe(1);

    // Reconnect replay finalizes again with the canonical timestamp.
    s.feed({ type: "message_end", message: assistantMsg(2000, "partial answer") });

    expect(s.rows().length).toBe(1);
  });

  it("CONTROL: stable timestamps across start/end/replay stay idempotent", () => {
    const s = makeStore(SID);
    s.feed({ type: "message_start", message: assistantMsg(3000, "") });
    s.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stable" } });
    s.feed({ type: "message_end", message: assistantMsg(3000, "stable") });
    s.feed({ type: "agent_end" });
    s.feed({ type: "message_end", message: assistantMsg(3000, "stable") });
    expect(s.rows().length).toBe(1);
  });
});
