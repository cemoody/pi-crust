import { describe, expect, it, vi } from "vitest";
import type { TimelineMessage } from "../../src/web/components/MessageTimeline.js";
import { applyRealtimeEvent } from "../../src/web/components/session-dashboard-realtime.js";

describe("session dashboard realtime reducer invariants", () => {
  it("tolerates arbitrary unknown/replayed event shapes without mutating timeline state", () => {
    const harness = makeHarness();
    const before = harness.snapshot();
    for (const event of fuzzUnknownEvents()) {
      expect(() => applyRealtimeEvent("s1", event, harness.setMessagesBySession, harness.streamDraftIds)).not.toThrow();
    }
    expect(harness.snapshot()).toEqual(before);
    expect(harness.streamDraftIds).toEqual({});
  });

  it("keeps one assistant row through start, deltas, and duplicate end replay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T00:00:00.000Z"));
    try {
      const harness = makeHarness();
      const sessionId = "s1";
      const end = {
        type: "message_end",
        message: { role: "assistant", content: "hello world", timestamp: 1_700_000_000_000 },
      };

      applyRealtimeEvent(sessionId, { type: "message_start", message: { role: "assistant", content: "", timestamp: 1_700_000_000_000 } }, harness.setMessagesBySession, harness.streamDraftIds);
      applyRealtimeEvent(sessionId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } }, harness.setMessagesBySession, harness.streamDraftIds);
      applyRealtimeEvent(sessionId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }, harness.setMessagesBySession, harness.streamDraftIds);
      applyRealtimeEvent(sessionId, end, harness.setMessagesBySession, harness.streamDraftIds);
      applyRealtimeEvent(sessionId, end, harness.setMessagesBySession, harness.streamDraftIds);

      const messages = harness.snapshot()[sessionId] ?? [];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: "assistant", text: "hello world", provider: "pi" });
      expect(harness.streamDraftIds).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes replayed legacy/user messages while preserving distinct authored turns", () => {
    const harness = makeHarness();
    const event = { type: "message", message: { role: "user", content: "same", timestamp: 1 } };
    applyRealtimeEvent("s1", event, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", event, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "message", message: { role: "user", content: "next", timestamp: 2 } }, harness.setMessagesBySession, harness.streamDraftIds);

    expect((harness.snapshot().s1 ?? []).map((message) => message.text)).toEqual(["same", "next"]);
  });

  it("merges tool update/end replays by toolCallId and keeps original args", () => {
    const harness = makeHarness();
    applyRealtimeEvent("s1", { type: "tool_execution_start", toolCallId: "abc", toolName: "bash", args: { command: "pwd" } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "tool_execution_update", toolCallId: "abc", toolName: "bash", partialResult: { content: [{ type: "text", text: "working" }] } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "tool_execution_end", toolCallId: "abc", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "tool_execution_end", toolCallId: "abc", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false }, harness.setMessagesBySession, harness.streamDraftIds);

    const messages = harness.snapshot().s1 ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tool).toMatchObject({ id: "abc", name: "bash", args: { command: "pwd" }, status: "success", output: "done" });
  });

  it("renders a custom artifact message delivered live via message_start/message_end", () => {
    const harness = makeHarness();
    const artifactMessage = {
      role: "custom",
      customType: "artifact",
      content: "Displayed image/png (12 KB).",
      timestamp: 1_700_000_111_000,
      details: {
        version: 1,
        artifactGroupId: "grp-1",
        caption: "my chart",
        artifacts: [
          { mime: "image/png", src: { kind: "url", url: "/artifacts/grp-1.png" }, alt: "my chart", bytes: 12000 },
          { mime: "text/plain", text: "Image: chart.png" },
        ],
      },
    };

    // Live delivery emits paired start/end with identical content.
    applyRealtimeEvent("s1", { type: "message_start", message: artifactMessage }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "message_end", message: artifactMessage }, harness.setMessagesBySession, harness.streamDraftIds);

    const messages = harness.snapshot().s1 ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "custom",
      customType: "artifact",
      artifact: { artifactGroupId: "grp-1", caption: "my chart", version: 1 },
    });
    expect(messages[0]!.artifact?.artifacts).toHaveLength(2);
  });

  it("still renders the artifact when only message_end is observed (mid-stream subscribe)", () => {
    const harness = makeHarness();
    const artifactMessage = {
      role: "custom",
      customType: "artifact",
      content: "Displayed image/png.",
      timestamp: 1_700_000_222_000,
      details: {
        version: 1,
        artifactGroupId: "grp-2",
        artifacts: [{ mime: "image/png", src: { kind: "url", url: "/artifacts/grp-2.png" }, alt: "x", bytes: 5 }],
      },
    };
    applyRealtimeEvent("s1", { type: "message_end", message: artifactMessage }, harness.setMessagesBySession, harness.streamDraftIds);
    const messages = harness.snapshot().s1 ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "custom", customType: "artifact", artifact: { artifactGroupId: "grp-2" } });
  });
});

function makeHarness(): {
  readonly streamDraftIds: Record<string, string>;
  readonly setMessagesBySession: (updater: Record<string, TimelineMessage[]> | ((current: Record<string, TimelineMessage[]>) => Record<string, TimelineMessage[]>)) => void;
  readonly snapshot: () => Record<string, TimelineMessage[]>;
} {
  let state: Record<string, TimelineMessage[]> = {};
  return {
    streamDraftIds: {},
    setMessagesBySession: (updater) => { state = typeof updater === "function" ? updater(state) : updater; },
    snapshot: () => structuredClone(state),
  };
}

function fuzzUnknownEvents(): Record<string, unknown>[] {
  return [
    {},
    { type: "message_start" },
    { type: "message_start", message: null },
    { type: "message_start", message: { role: "system", content: "ignored" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 123 } },
    { type: "message_update", assistantMessageEvent: { type: "unknown", delta: "ignored" } },
    { type: "message_end", message: { role: "user", content: "ignored" } },
    { type: "tool_execution_start", toolCallId: 123, toolName: "bash" },
    { type: "tool_execution_update", toolCallId: "abc" },
    { type: "tool_execution_end", toolName: "bash" },
    { type: "future_event", nested: { arbitrary: [1, true, null] } },
  ];
}
