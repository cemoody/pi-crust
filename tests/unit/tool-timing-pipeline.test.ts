import { describe, expect, it } from "vitest";
import { toSessionMessages } from "../../src/server/pi/pirpc-pi-adapter.js";
import { toDashboardMessages } from "../../src/server/http-api-server.js";

// Bug report: after history reload the tool row's status text fell back
// to 'done' instead of showing the real elapsed time. Streaming worked
// because SessionDashboard's SSE reducer stamps Date.now() onto
// startedAt / completedAt as tool_execution_start / tool_execution_end
// fire \u2014 but neither timestamp was being persisted through the
// JSONL pipeline, so reloaded sessions lost the duration.
//
// These tests pin the pipeline: assistant toolCall \u2192 toolResult chain
// must surface both timestamps on the tool entry through SessionMessage
// and DashboardMessage.

const TURN = [
  // Assistant turn at T0 emits a toolCall.
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me list the files." },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
    ],
    timestamp: 1778800000000,
  },
  // Tool result arrives 12.4s later.
  {
    role: "toolResult",
    toolCallId: "call_1",
    content: [{ type: "text", text: "file-a\nfile-b\n" }],
    isError: false,
    timestamp: 1778800012400,
  },
];

describe("tool-timing pipeline", () => {
  it("stamps startedAt from the assistant turn and completedAt from the toolResult", () => {
    const sessionMessages = toSessionMessages(TURN);
    const toolEntry = sessionMessages.find((m) => m.role === "tool");
    expect(toolEntry, "tool entry must be emitted").toBeDefined();
    expect(toolEntry?.tool?.startedAt).toBe(1778800000000);
    expect(toolEntry?.tool?.completedAt).toBe(1778800012400);
    expect(toolEntry?.tool?.status).toBe("success");
  });

  it("forwards the timestamps through toDashboardMessages onto DashboardToolDetails", () => {
    const dashboard = toDashboardMessages(toSessionMessages(TURN));
    const tool = dashboard.find((m) => m.role === "tool")?.tool;
    expect(tool).toBeDefined();
    expect(tool?.startedAt).toBe(1778800000000);
    expect(tool?.completedAt).toBe(1778800012400);
  });

  it("leaves the running tool's completedAt undefined while the toolResult is missing", () => {
    const sessionMessages = toSessionMessages([TURN[0]]);
    const toolEntry = sessionMessages.find((m) => m.role === "tool");
    expect(toolEntry).toBeDefined();
    expect(toolEntry?.tool?.startedAt).toBe(1778800000000);
    expect(toolEntry?.tool?.completedAt).toBeUndefined();
    expect(toolEntry?.tool?.status).toBe("running");
  });
});
