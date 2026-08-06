import { describe, expect, it } from "vitest";
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

  it("keeps one assistant row through start, deltas, and duplicate end replay (real time)", () => {
    // Intentionally use REAL timers. A previous version of this test froze
    // Date.now() with fake timers, which masked a production bug: a replayed
    // message_end mints a fresh time-based draft id and appends a duplicate
    // row. With real timers the second message_end happens at a later Date.now()
    // so the regression is exercised the way the SSE auto-reconnect replay hits
    // it in the browser.
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
  });

  it("does not merge two distinct assistant turns when an end replays for the second", () => {
    const harness = makeHarness();
    const sessionId = "s1";
    // Turn 1.
    applyRealtimeEvent(sessionId, { type: "message_start", message: { role: "assistant", content: "", timestamp: 1_700_000_000_000 } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent(sessionId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent(sessionId, { type: "message_end", message: { role: "assistant", content: "first", timestamp: 1_700_000_000_000 } }, harness.setMessagesBySession, harness.streamDraftIds);
    // Turn 2.
    applyRealtimeEvent(sessionId, { type: "message_start", message: { role: "assistant", content: "", timestamp: 1_700_000_111_000 } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent(sessionId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second" } }, harness.setMessagesBySession, harness.streamDraftIds);
    const end2 = { type: "message_end", message: { role: "assistant", content: "second", timestamp: 1_700_000_111_000 } };
    applyRealtimeEvent(sessionId, end2, harness.setMessagesBySession, harness.streamDraftIds);
    // Replayed end for turn 2 must NOT append a third row or clobber turn 1.
    applyRealtimeEvent(sessionId, end2, harness.setMessagesBySession, harness.streamDraftIds);

    expect((harness.snapshot()[sessionId] ?? []).map((message) => message.text)).toEqual(["first", "second"]);
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

  it("keeps concurrent live tool calls isolated until each reaches its own terminal event", () => {
    const harness = makeHarness();
    applyRealtimeEvent("s1", { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "first" } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "tool_execution_start", toolCallId: "bash-2", toolName: "bash", args: { command: "second" } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "tool_execution_update", toolCallId: "bash-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "first progress" }] } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "tool_execution_update", toolCallId: "bash-2", toolName: "bash", partialResult: { content: [{ type: "text", text: "second progress" }] } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: { content: [{ type: "text", text: "first done" }] }, isError: false }, harness.setMessagesBySession, harness.streamDraftIds);

    const byToolId = Object.fromEntries((harness.snapshot().s1 ?? []).map((message) => [message.tool?.id, message.tool]));
    expect(byToolId["bash-1"]).toMatchObject({ status: "success", args: { command: "first" }, output: "first done" });
    expect(byToolId["bash-2"]).toMatchObject({ status: "running", args: { command: "second" }, output: "second progress" });
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
