import { describe, expect, it } from "vitest";
import {
  clearExtensionUiRequest,
  initialWebSessionState,
  reduceExtensionUiRequest,
  reducePiEvent,
} from "../../src/web/state/pi-event-reducer.js";

describe("Pi event reducer", () => {
  it("handles agent lifecycle", () => {
    const running = reducePiEvent(initialWebSessionState, { type: "agent_start" });
    expect(running.status).toBe("running");

    const idle = reducePiEvent(running, { type: "agent_end" });
    expect(idle.status).toBe("idle");
  });

  it("merges streaming text deltas into one assistant draft", () => {
    let state = reducePiEvent(initialWebSessionState, {
      type: "message_update",
      message: { role: "assistant", content: "" },
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    state = reducePiEvent(state, {
      type: "message_update",
      message: { role: "assistant", content: "" },
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.text).toBe("hello world");
  });

  it("merges thinking deltas into the current draft", () => {
    const state = reducePiEvent(initialWebSessionState, {
      type: "message_update",
      message: { role: "assistant", content: "" },
      assistantMessageEvent: { type: "thinking_delta", delta: "considering" },
    });

    expect(state.messages[0]?.thinking).toBe("considering");
  });

  it("tracks tool call argument deltas", () => {
    let state = reducePiEvent(initialWebSessionState, {
      type: "message_update",
      message: { role: "assistant", content: "" },
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{\"command\":" },
    });
    state = reducePiEvent(state, {
      type: "message_update",
      message: { role: "assistant", content: "" },
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "\"ls\"}" },
    });

    expect(state.toolCallDrafts["0"]).toBe("{\"command\":\"ls\"}");
  });

  it("tracks extension UI request lifecycle", () => {
    const requested = reduceExtensionUiRequest(initialWebSessionState, {
      id: "ui-1",
      method: "confirm",
      title: "Allow?",
    });
    expect(requested.extensionUiRequests).toHaveLength(1);

    const cleared = clearExtensionUiRequest(requested, "ui-1");
    expect(cleared.extensionUiRequests).toHaveLength(0);
  });

  it("tracks tool start, update, and success", () => {
    let state = reducePiEvent(initialWebSessionState, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    expect(state.tools["tool-1"]?.status).toBe("running");

    state = reducePiEvent(state, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "echo hi" },
      partialResult: { content: [{ type: "text", text: "hi" }] },
    });
    expect(state.tools["tool-1"]?.output).toBe("hi");

    state = reducePiEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hi\n" }] },
      isError: false,
    });
    expect(state.tools["tool-1"]?.status).toBe("success");
    expect(state.tools["tool-1"]?.output).toBe("hi\n");
  });

  it("tracks tool errors and truncation", () => {
    const state = reducePiEvent(initialWebSessionState, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "abcdef" }] },
      isError: true,
    }, { maxToolOutputChars: 3 });

    expect(state.tools["tool-1"]?.status).toBe("error");
    expect(state.tools["tool-1"]?.truncated).toBe(true);
  });

  it("updates steering and follow-up queues", () => {
    const state = reducePiEvent(initialWebSessionState, {
      type: "queue_update",
      steering: ["stop"],
      followUp: ["then test"],
    });

    expect(state.queues.steering).toEqual(["stop"]);
    expect(state.queues.followUp).toEqual(["then test"]);
  });

  it("tracks compaction lifecycle", () => {
    const compacting = reducePiEvent(initialWebSessionState, { type: "compaction_start", reason: "manual" });
    expect(compacting.status).toBe("compacting");
    expect(compacting.compaction).toMatchObject({ active: true, reason: "manual" });

    const done = reducePiEvent(compacting, {
      type: "compaction_end",
      reason: "manual",
      result: { summary: "done" },
      aborted: false,
    });
    expect(done.status).toBe("idle");
    expect(done.compaction).toMatchObject({ active: false, reason: "manual" });
  });

  it("tracks retry lifecycle and final error", () => {
    const retrying = reducePiEvent(initialWebSessionState, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "rate limited",
    });
    expect(retrying.status).toBe("retrying");
    expect(retrying.retry).toMatchObject({ active: true, attempt: 1, maxAttempts: 3 });

    const failed = reducePiEvent(retrying, {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "still rate limited",
    });
    expect(failed.status).toBe("error");
    expect(failed.retry).toMatchObject({ active: false, finalError: "still rate limited" });
  });

  // TDD characterization: bug-fix lock-in. Before the shared/wire-content
  // consolidation, message_start / message_end on an assistant message whose
  // wire `content` was a structured-content ARRAY containing a thinking
  // block would JSON.stringify the entire thinking block into
  // WebMessage.text — so the assistant bubble would render literal
  // `{"type":"thinking","thinking":"..."}` JSON to the user, and
  // WebMessage.thinking stayed empty. The canonical wire-content helper
  // separates the two; this test pins down the corrected behavior so we
  // can't regress.
  it("separates thinking and text from a structured-content assistant message", () => {
    const started = reducePiEvent(initialWebSessionState, {
      type: "message_start",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning step" },
          { type: "text", text: "visible answer" },
        ],
      },
    });
    expect(started.messages).toHaveLength(1);
    expect(started.messages[0]!.text).toBe("visible answer");
    expect(started.messages[0]!.thinking).toBe("reasoning step");
  });

  it("skips toolCall / unknown blocks instead of stringifying them into text", () => {
    const ended = reducePiEvent(initialWebSessionState, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolCall", id: "t1", name: "bash" },
          { type: "weird-extension" },
          { type: "text", text: "after" },
        ],
      },
    });
    const message = ended.messages[ended.messages.length - 1]!;
    expect(message.text).toBe("before\nafter");
    expect(message.thinking).toBe("");
  });
});
