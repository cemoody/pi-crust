import { describe, expect, it } from "vitest";
import { toSessionMessages } from "../../src/server/pi/pirpc-pi-adapter.js";
import { toDashboardMessages } from "../../src/server/http-api-server.js";

// Reproduces the "frozen session" symptom from session
// 019e1c60-8c28-768d-9c0c-ab1a144fe250: the Anthropic API rejected an
// over-2000px image and the JSONL captured an assistant turn whose
// `content` array is EMPTY with `stopReason: "error"` and an `errorMessage`
// describing the 400. The WUI then renders an empty bubble with nothing
// telling the user what happened, so the session "looks frozen".
//
// The fix must make sure those error fields survive the conversion pipeline:
//   raw JSONL -> SessionMessage -> DashboardMessage -> TimelineMessage.

const REAL_FROZEN_TURN = {
  type: "message",
  id: "0fa683a2",
  parentId: "360038fa",
  timestamp: "2026-05-12T16:42:46.074Z",
  message: {
    role: "assistant",
    content: [] as unknown[],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-7",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "error",
    timestamp: 1778604164803,
    errorMessage:
      '400 {"error":{"message":"messages.12.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels","type":"invalid_request_error"}}',
  },
};

describe("error-turn pipeline", () => {
  it("toSessionMessages emits an assistant entry even when content is empty, carrying stopReason and errorMessage", () => {
    const raw = [REAL_FROZEN_TURN.message];
    const sessionMessages = toSessionMessages(raw);

    const assistant = sessionMessages.find((m) => m.role === "assistant");
    expect(assistant, "an assistant message should be emitted even with empty content").toBeDefined();
    expect(assistant?.stopReason).toBe("error");
    expect(assistant?.errorMessage).toContain("2000 pixels");
  });

  it("toDashboardMessages exposes errorMessage as `error` and forwards stopReason", () => {
    const sessionMessages = [
      {
        role: "assistant" as const,
        content: "",
        timestamp: 1778604164803,
        stopReason: "error",
        errorMessage: "400 invalid_request_error: image too large",
      },
    ];
    const dashboard = toDashboardMessages(sessionMessages);
    expect(dashboard).toHaveLength(1);
    const msg = dashboard[0]!;
    expect(msg.role).toBe("assistant");
    expect(msg.stopReason).toBe("error");
    expect(msg.error).toBe("400 invalid_request_error: image too large");
  });

  it("end-to-end: a frozen-style assistant turn ends up with a user-visible error on the DashboardMessage", () => {
    const sessionMessages = toSessionMessages([REAL_FROZEN_TURN.message]);
    const dashboard = toDashboardMessages(sessionMessages);
    const errored = dashboard.find((m) => m.role === "assistant" && m.stopReason === "error");
    expect(errored, "expected at least one errored assistant DashboardMessage").toBeDefined();
    expect(errored?.error).toContain("2000 pixels");
  });
});
