import { describe, it, expect } from "vitest";
import { applyRealtimeEvent, toTimelineMessage } from "../../src/web/components/session-dashboard-realtime.js";
import type { DashboardMessage } from "../../src/web/api/session-api.js";
import type { TimelineMessage } from "../../src/web/components/MessageTimeline.js";

function makeStore(sessionId: string, initial: TimelineMessage[]) {
  let state: Record<string, TimelineMessage[]> = { [sessionId]: initial };
  const draftIds: Record<string, string> = {};
  const set: import("react").Dispatch<import("react").SetStateAction<Record<string, TimelineMessage[]>>> = (updater) => {
    state = typeof updater === "function" ? updater(state) : updater;
  };
  const feed = (event: Record<string, unknown>) => applyRealtimeEvent(sessionId, event, set, draftIds);
  const rows = () => state[sessionId] ?? [];
  return { feed, rows, draftIds };
}

const SID = "sess-rest-stream";
const TS = 1_700_000_000_000;
const TEXT = "Yes. Google often blocks sign-in from embedded browsers.\n\n1. Open this URL...";
const wireAssistant = (content: unknown) => ({ role: "assistant", timestamp: TS, content });

describe("REST transcript + later live stream duplicate repro", () => {
  it("does not duplicate when /messages already loaded the finalized assistant and SSE replays the full same turn", () => {
    const persisted = toTimelineMessage({
      id: `${TS}-12`,
      role: "assistant",
      text: TEXT,
      provider: "pi",
      timestamp: TS,
    } as DashboardMessage);
    const s = makeStore(SID, [persisted]);

    // What can happen during session open/reconnect: /messages wins the race
    // and renders the completed JSONL turn, then the buffered SSE start/deltas/end
    // for the same logical turn arrive afterwards under a different live id.
    s.feed({ type: "message_start", message: wireAssistant("") });
    s.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: TEXT } });
    s.feed({ type: "message_end", message: wireAssistant(TEXT) });

    const assistantRows = s.rows().filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]?.text).toBe(TEXT);
  });

  it("does not drop a later live turn whose text has the previous loaded turn as a prefix", () => {
    const previous = toTimelineMessage({
      id: `${TS}-12`,
      role: "assistant",
      text: "deploy finished",
      provider: "pi",
      timestamp: TS,
    } as DashboardMessage);
    const s = makeStore(SID, [previous]);

    const laterTs = TS + 10_000;
    const laterText = "deploy finished\n\nNext, verify the rollout.";
    s.feed({ type: "message_start", message: { role: "assistant", timestamp: laterTs, content: "" } });
    s.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: laterText } });
    s.feed({ type: "message_end", message: { role: "assistant", timestamp: laterTs, content: laterText } });

    const assistantRows = s.rows().filter((m) => m.role === "assistant");
    expect(assistantRows.map((row) => row.text)).toEqual(["deploy finished", laterText]);
  });

  it("does not drop a later live turn that intentionally repeats the same text", () => {
    const previous = toTimelineMessage({
      id: `${TS}-12`,
      role: "assistant",
      text: "Done.",
      provider: "pi",
      timestamp: TS,
    } as DashboardMessage);
    const s = makeStore(SID, [previous]);

    const laterTs = TS + 10_000;
    s.feed({ type: "message_start", message: { role: "assistant", timestamp: laterTs, content: "" } });
    s.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } });
    s.feed({ type: "message_end", message: { role: "assistant", timestamp: laterTs, content: "Done." } });

    const assistantRows = s.rows().filter((m) => m.role === "assistant");
    expect(assistantRows.map((row) => row.text)).toEqual(["Done.", "Done."]);
  });
});
