import { describe, expect, it } from "vitest";
import { contentTextAndThinking, toSessionMessages } from "../../src/server/pi/session-message-normalizer.js";

describe("session message normalizer", () => {
  it("joins a persisted tool result with its call while preserving externalized image metadata", () => {
    const payloadRef = {
      __piCrustPayloadRef: {
        version: 1,
        file: "image.b64",
        bytes: 42,
        encoding: "base64",
        reason: "image",
      },
    };
    const messages = toSessionMessages([
      {
        role: "assistant",
        timestamp: 100,
        content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "chart.png" } }],
      },
      {
        role: "toolResult",
        timestamp: 250,
        toolCallId: "read-1",
        isError: false,
        content: [
          { type: "text", text: "Read chart" },
          { type: "image", mimeType: "image/png", __piCrustPayloadRef: payloadRef.__piCrustPayloadRef },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "tool",
      content: "Read chart",
      timestamp: 250,
      tool: {
        id: "read-1",
        status: "success",
        startedAt: 100,
        completedAt: 250,
        images: [{ data: "", mimeType: "image/png", payloadRef }],
      },
    });
  });

  it("keeps visible text, thinking, and inline images as distinct channels", () => {
    expect(contentTextAndThinking([
      { type: "thinking", thinking: "Inspect the response." },
      { type: "text", text: "Here is the result." },
      { type: "image", data: "QUJD", mimeType: "image/jpeg" },
    ])).toEqual({
      text: "Here is the result.",
      thinking: "Inspect the response.",
      images: [{ data: "QUJD", mimeType: "image/jpeg" }],
    });
  });
});
