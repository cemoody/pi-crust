// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageTimeline } from "../../src/web/components/MessageTimeline.js";

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe("MessageTimeline", () => {
  it("renders user text and image attachments", () => {
    render(<MessageTimeline messages={[{
      id: "u1",
      role: "user",
      text: "look at this",
      images: [{ id: "img", src: "data:image/png;base64,abc", alt: "screenshot" }],
    }]} />);

    expect(screen.getByText("look at this")).toBeInTheDocument();
    expect(screen.getByAltText("screenshot")).toBeInTheDocument();
  });

  it("renders assistant markdown headings and code blocks", () => {
    render(<MessageTimeline messages={[{
      id: "a1",
      role: "assistant",
      text: "## Plan\n\n```ts\nconst x = 1;\n```",
    }]} />);

    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("hides thinking blocks when requested", () => {
    const { rerender } = render(<MessageTimeline messages={[{
      id: "a1",
      role: "assistant",
      text: "answer",
      thinking: "private reasoning",
    }]} />);
    expect(screen.getByText("private reasoning")).toBeInTheDocument();

    rerender(<MessageTimeline hideThinking messages={[{
      id: "a1",
      role: "assistant",
      text: "answer",
      thinking: "private reasoning",
    }]} />);
    expect(screen.queryByText("private reasoning")).not.toBeInTheDocument();
  });

  it("renders assistant metadata, errors, and aborted state", () => {
    render(<MessageTimeline messages={[{
      id: "a1",
      role: "assistant",
      text: "oops",
      provider: "anthropic",
      model: "claude",
      stopReason: "error",
      tokenUsage: "10 tokens",
      cost: "$0.01",
      error: "failed",
      aborted: true,
    }]} />);

    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("10 tokens")).toBeInTheDocument();
    expect(screen.getByText("$0.01")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("failed");
    expect(screen.getByText("aborted")).toBeInTheDocument();
  });

  it("renders custom and summary messages", () => {
    render(<MessageTimeline messages={[
      { id: "c1", role: "custom", customLabel: "Todo extension", text: "todo state" },
      { id: "s1", role: "summary", summaryKind: "branch", text: "branch work" },
      { id: "s2", role: "summary", summaryKind: "compaction", text: "older work" },
    ]} />);

    expect(screen.getByText("Todo extension")).toBeInTheDocument();
    expect(screen.getByText("Branch summary")).toBeInTheDocument();
    expect(screen.getByText("Compaction summary")).toBeInTheDocument();
  });

  it("copies message text", () => {
    render(<MessageTimeline messages={[{ id: "a1", role: "assistant", text: "copy me" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("copy me");
  });

  it("auto-scrolls to the end when enabled", () => {
    render(<MessageTimeline autoScroll messages={[{ id: "a1", role: "assistant", text: "hi" }]} />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
