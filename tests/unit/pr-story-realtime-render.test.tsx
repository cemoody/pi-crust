// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageTimeline, type TimelineMessage } from "../../src/web/components/MessageTimeline.js";
import { applyRealtimeEvent } from "../../src/web/components/session-dashboard-realtime.js";
import { prStoryFixture } from "../fixtures/pr-story-artifact.js";

/**
 * Regression guard for the PR #204 *class* of bug, but for the path PR Story
 * actually uses. The `show_pr_story` pi tool returns
 * `details.piRemoteControlArtifact = { kind: "pr-story", data: <story> }`, so a
 * PR Story is delivered to the web client as a TOOL message via the realtime
 * gateway's paired `tool_execution_start` / `tool_execution_end` events — NOT as
 * a `role: "custom"` / `customType: "artifact"` message (which is what the
 * @cemoody/pi-artifact display(...) tool uses, and what
 * session-dashboard-realtime-invariants.test.ts already covers).
 *
 * That tool-artifact live path was previously unguarded for PR Story: if the
 * realtime reducer dropped `result.details.piRemoteControlArtifact` from
 * `tool_execution_end` (the same way the custom-message path was dropped before
 * PR #204), a freshly produced PR Story would only appear after a full page
 * reload (the /messages history loader). These tests pin the live path:
 *   1. start + end reduce to a single tool row carrying the pr-story artifact;
 *   2. end-only delivery (mid-stream subscribe) still yields the artifact;
 *   3. the reduced live row renders as a PR Story card, never raw JSON.
 */

const toolCallId = "call_show_pr_story_live";
const toolName = "show_pr_story";

// The exact wire shape the show_pr_story tool emits on completion: its
// execute() returns { content, details: { piRemoteControlArtifact: {...} } },
// and the host forwards that object as the tool_execution_end `result`.
const toolEndResult = {
  content: [{ type: "text", text: `Displayed PR Story: ${prStoryFixture.title} (${prStoryFixture.frames.length} frames).` }],
  details: {
    piRemoteControlArtifact: {
      version: 1,
      kind: "pr-story",
      title: prStoryFixture.title,
      storyId: prStoryFixture.id,
      data: prStoryFixture,
    },
  },
};

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

describe("PR Story realtime tool-artifact reducer", () => {
  it("reduces a live show_pr_story tool start/end into one row carrying the pr-story artifact", () => {
    const harness = makeHarness();

    applyRealtimeEvent("s1", {
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args: { story: prStoryFixture },
    }, harness.setMessagesBySession, harness.streamDraftIds);

    // Mid-execution snapshot: one running tool row, no artifact yet.
    let messages = harness.snapshot().s1 ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tool).toMatchObject({ id: toolCallId, name: toolName, status: "running" });
    expect(messages[0]!.tool?.artifact).toBeUndefined();

    applyRealtimeEvent("s1", {
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: toolEndResult,
      isError: false,
    }, harness.setMessagesBySession, harness.streamDraftIds);

    // The end event merges into the SAME row (keyed by toolCallId) and must
    // surface the pr-story artifact via extractArtifact(result.details.*).
    messages = harness.snapshot().s1 ?? [];
    expect(messages, "tool start/end must collapse to one row").toHaveLength(1);
    expect(messages[0]!.tool).toMatchObject({ id: toolCallId, name: toolName, status: "success" });
    expect(messages[0]!.tool?.artifact).toMatchObject({ kind: "pr-story", storyId: prStoryFixture.id, title: prStoryFixture.title });
    // The original args are preserved across the merge (mergeTimelineMessage).
    expect(messages[0]!.tool?.args).toMatchObject({ story: { id: prStoryFixture.id } });
  });

  it("still surfaces the pr-story artifact when only tool_execution_end is observed (mid-stream subscribe)", () => {
    const harness = makeHarness();

    applyRealtimeEvent("s1", {
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: toolEndResult,
      isError: false,
    }, harness.setMessagesBySession, harness.streamDraftIds);

    const messages = harness.snapshot().s1 ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tool?.artifact).toMatchObject({ kind: "pr-story", storyId: prStoryFixture.id });
  });

  it("renders the live-reduced row as a PR Story card, not raw JSON", () => {
    const harness = makeHarness();
    applyRealtimeEvent("s1", { type: "tool_execution_start", toolCallId, toolName, args: { story: prStoryFixture } }, harness.setMessagesBySession, harness.streamDraftIds);
    applyRealtimeEvent("s1", { type: "tool_execution_end", toolCallId, toolName, result: toolEndResult, isError: false }, harness.setMessagesBySession, harness.streamDraftIds);

    render(<MessageTimeline messages={harness.snapshot().s1 ?? []} />);

    const card = screen.getByTestId("artifact-pr-story");
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent(prStoryFixture.title);
    expect(card).toHaveTextContent("octo/svc#7");
    expect(screen.getByRole("button", { name: "Open story" })).toBeInTheDocument();
    // The raw story JSON must never leak into the rendered card.
    expect(card).not.toHaveTextContent("schemaVersion");
    expect(screen.queryByTestId("artifact-fallback")).not.toBeInTheDocument();
  });
});
