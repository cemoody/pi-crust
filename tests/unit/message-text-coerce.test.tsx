/**
 * Pins the contract that even when `message.text` is a non-string at
 * runtime (Array, Object, null, undefined), the pi-crust's text-extraction
 * helpers (lastAssistantTextOf, turnToMarkdown) do not throw.
 *
 * These helpers were the secondary symptom of the same upstream bug
 * fixed in safe-markdown.ts: with a malformed payload, the timeline
 * would throw inside `text.trim()` after the markdown-side coercion
 * already saved react-markdown. The error boundary contained the
 * throw but the timeline didn't render. With the asTrimmedString
 * helper introduced in this fix, the timeline renders cleanly.
 *
 * We exercise the helpers via their public outputs: a deliberately
 * malformed turn shape that previously triggered the
 * "text.trim is not a function" TypeError.
 */
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MessageTimeline, type TimelineMessage } from "../../src/web/components/MessageTimeline.js";

// MessageTimeline uses some browser-only APIs (matchMedia etc.) — stub.
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MessageTimeline tolerates non-string message.text", () => {
  it("renders without throwing when an assistant text is an Array (the original repro shape)", () => {
    const messages: TimelineMessage[] = [
      { id: "u1", role: "user", text: "hello", timestamp: 1700000000000 },
      // The exact shape observed in session 019e4de3-… (some path through
      // the message pipeline produced an Array instead of a string).
      { id: "a1", role: "assistant", text: ["fragment 1", "fragment 2"] as unknown as string, timestamp: 1700000000001 },
      { id: "a2", role: "assistant", text: "well-formed reply", timestamp: 1700000000002 },
    ];
    expect(() =>
      render(<MessageTimeline messages={messages} streaming={false} sessionId="s1" />),
    ).not.toThrow();
    // The well-formed reply must still render.
    expect(screen.getByText("well-formed reply")).toBeInTheDocument();
  });

  it("renders without throwing when assistant text is an Object", () => {
    const messages: TimelineMessage[] = [
      { id: "a1", role: "assistant", text: { ohno: "object shape" } as unknown as string, timestamp: 1700000000003 },
      { id: "a2", role: "assistant", text: "and this still renders", timestamp: 1700000000004 },
    ];
    expect(() =>
      render(<MessageTimeline messages={messages} streaming={false} sessionId="s1" />),
    ).not.toThrow();
    expect(screen.getByText("and this still renders")).toBeInTheDocument();
  });

  it("renders without throwing when assistant text is null / undefined", () => {
    const messages: TimelineMessage[] = [
      { id: "a1", role: "assistant", text: null as unknown as string, timestamp: 1700000000005 },
      { id: "a2", role: "assistant", text: undefined as unknown as string, timestamp: 1700000000006 },
      { id: "u1", role: "user", text: "follow-up question", timestamp: 1700000000007 },
    ];
    expect(() =>
      render(<MessageTimeline messages={messages} streaming={false} sessionId="s1" />),
    ).not.toThrow();
    expect(screen.getByText("follow-up question")).toBeInTheDocument();
  });
});
