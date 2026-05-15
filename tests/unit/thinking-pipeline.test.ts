import { describe, expect, it } from "vitest";
import { toSessionMessages } from "../../src/server/pi/pirpc-pi-adapter.js";
import { toDashboardMessages } from "../../src/server/http-api-server.js";

// Bug repro: on mobile (and after any session reload) the assistant's
// reasoning/"thinking" content blocks were rendered as plain Markdown
// paragraphs in the same bubble as the visible reply \u2014 producing
// stream-of-consciousness "Exploring BigQuery options" passages right next
// to the real assistant text.
//
// Root cause: pirpc-pi-adapter's contentTextAndImages pushed both
// `block.text` and `block.thinking` into the same string, so the persisted
// SessionMessage had a single combined `content`. The WUI's
// MessageTimeline already has a dedicated <details className="thinking-block">
// collapsed widget driven off TimelineMessage.thinking, but the pipeline
// never populated that field on history reload (only streaming did, via a
// different code path).
//
// These tests pin the pipeline: thinking must survive as its own field
// from raw JSONL \u2192 SessionMessage \u2192 DashboardMessage.

const ASSISTANT_TURN_WITH_THINKING = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Exploring BigQuery options\n\nI'm considering using BigQuery for my task..." },
    { type: "text", text: "Let me start by listing the available tables with `bq ls`." },
    { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "bq ls" } },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-opus-4-7",
  stopReason: "toolUse",
  timestamp: 1778700000000,
};

describe("thinking pipeline", () => {
  it("toSessionMessages emits thinking on a separate field, not concatenated into content", () => {
    const sessionMessages = toSessionMessages([ASSISTANT_TURN_WITH_THINKING]);
    const assistant = sessionMessages.find((m) => m.role === "assistant");
    expect(assistant, "an assistant message must be emitted").toBeDefined();
    // The visible text only \u2014 thinking is *not* part of content.
    expect(assistant?.content).toBe("Let me start by listing the available tables with `bq ls`.");
    expect(assistant?.thinking).toContain("Exploring BigQuery options");
    expect(assistant?.thinking).toContain("considering using BigQuery");
  });

  it("toDashboardMessages forwards thinking onto the DashboardMessage", () => {
    const dashboard = toDashboardMessages([
      {
        role: "assistant",
        content: "Let me try running bq ls.",
        thinking: "I should check the schema first.",
        timestamp: 1778700000000,
      },
    ]);
    expect(dashboard).toHaveLength(1);
    expect(dashboard[0]!.text).toBe("Let me try running bq ls.");
    expect(dashboard[0]!.thinking).toBe("I should check the schema first.");
  });

  it("end-to-end: a raw thinking-bearing assistant turn produces a DashboardMessage with thinking separated", () => {
    const sessionMessages = toSessionMessages([ASSISTANT_TURN_WITH_THINKING]);
    const dashboard = toDashboardMessages(sessionMessages);
    const assistant = dashboard.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.text).toBe("Let me start by listing the available tables with `bq ls`.");
    expect(assistant?.thinking).toContain("Exploring BigQuery options");
    // And the thinking text must NOT also be smuggled inside `text`.
    expect(assistant?.text).not.toContain("Exploring BigQuery options");
    expect(assistant?.text).not.toContain("considering using BigQuery");
  });
});
