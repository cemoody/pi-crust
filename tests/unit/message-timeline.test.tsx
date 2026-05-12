// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("copies code block text", () => {
    render(<MessageTimeline messages={[{
      id: "a1",
      role: "assistant",
      text: "```ts\nconst x = 1;\n```",
    }]} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("const x = 1;"));
  });

  it("falls back to textarea copy when the async clipboard API is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    let fallbackValue = "";
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => {
        fallbackValue = document.querySelector("textarea")?.value ?? "";
        return true;
      }),
    });

    render(<MessageTimeline messages={[{
      id: "a1",
      role: "assistant",
      text: "```sh\necho fallback\n```",
    }]} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(fallbackValue).toContain("echo fallback");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("shows an inline failure state when code copy fails", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });

    render(<MessageTimeline messages={[{
      id: "a1",
      role: "assistant",
      text: "```sh\necho nope\n```",
    }]} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).toBeInTheDocument());
  });

  it("auto-scrolls to the end when enabled", () => {
    render(<MessageTimeline autoScroll messages={[{ id: "a1", role: "assistant", text: "hi" }]} />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("renders typing dots while streaming", () => {
    render(<MessageTimeline streaming messages={[{ id: "a1", role: "assistant", text: "working" }]} />);
    expect(screen.getByRole("status", { name: "Assistant is responding" })).toBeInTheDocument();
  });

  it("renders a tool card with status and args", () => {
    render(<MessageTimeline messages={[{
      id: "t1",
      role: "tool",
      text: "",
      tool: {
        id: "call_1",
        name: "bash",
        args: { command: "ls -la" },
        status: "success",
        output: "package.json\nREADME.md",
      },
    }]} />);
    const card = screen.getByLabelText("tool bash");
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent("Ran");
    expect(card).toHaveTextContent("ls -la");
    expect(card).toHaveTextContent("done");
  });

  it("shows running tool card without output", () => {
    render(<MessageTimeline messages={[{
      id: "t1",
      role: "tool",
      text: "",
      tool: { id: "call_1", name: "read", args: { path: "src/app.ts" }, status: "running", output: "" },
    }]} />);
    const card = screen.getByLabelText("tool read");
    expect(card).toHaveTextContent("Read");
    expect(card).toHaveTextContent("running");
    expect(card.querySelector("pre")).toBeNull();
  });

  it("renders orphan tool-result text as preformatted output instead of markdown", () => {
    render(<MessageTimeline messages={[{
      id: "t-orphan",
      role: "tool",
      text: "> pi-remote-control@0.0.0 typecheck tsc --noEmit\nD file.ts M other.ts\ncreate mode 100644 package.json",
    }]} />);

    const orphan = screen.getByLabelText("tool result");
    expect(orphan).toBeInTheDocument();
    const pre = orphan.querySelector("pre");
    expect(pre).toHaveTextContent("> pi-remote-control@0.0.0 typecheck tsc --noEmit");
    expect(orphan.querySelector("blockquote")).toBeNull();
  });

  it("renders an inline Vega-Lite chart from a custom artifact message", () => {
    const spec = {
      mark: "bar",
      data: { values: [{ x: "a", y: 3 }, { x: "b", y: 5 }, { x: "c", y: 2 }] },
      encoding: {
        x: { field: "x", type: "nominal" },
        y: { field: "y", type: "quantitative" },
      },
    };
    render(<MessageTimeline messages={[{
      id: "art-1",
      role: "custom",
      customType: "artifact",
      text: "Small bar chart (Vega-Lite spec, 170 B)",
      artifact: {
        version: 1,
        artifactGroupId: "abc123",
        caption: "Small bar chart",
        artifacts: [
          { mime: "application/vnd.vega-lite.v5+json", spec },
          { mime: "text/plain", text: "Small bar chart" },
        ],
      },
    }]} />);

    const figure = screen.getByTestId("artifact-vega-lite");
    expect(figure).toBeInTheDocument();
    // The spec is exposed on a data attribute so we can verify the right payload
    // reached the renderer, even though the chart itself paints asynchronously.
    expect(JSON.parse(figure.getAttribute("data-spec") ?? "null")).toEqual(spec);
    expect(screen.getByText("Small bar chart")).toBeInTheDocument();
  });

  it("falls back to text/plain when no recognized artifact representation is present", () => {
    render(<MessageTimeline messages={[{
      id: "art-2",
      role: "custom",
      customType: "artifact",
      text: "Mystery artifact",
      artifact: {
        version: 1,
        artifactGroupId: "def456",
        artifacts: [
          { mime: "application/x-unknown", data: "opaque" } as any,
          { mime: "text/plain", text: "Mystery artifact fallback" },
        ],
      },
    }]} />);

    expect(screen.getByTestId("artifact-fallback")).toHaveTextContent("Mystery artifact fallback");
  });

  it("renders Pi Remote Control artifact metadata from tool results", () => {
    render(<MessageTimeline messages={[{
      id: "t1",
      role: "tool",
      text: "",
      tool: {
        id: "call_1",
        name: "show_artifact",
        args: {},
        status: "success",
        output: "Displayed markdown artifact: Report.",
        artifact: { kind: "markdown", title: "Report", markdown: "## Chart\n\nResult details" },
      },
    }]} />);

    expect(screen.getByText("Report")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chart" })).toBeInTheDocument();
    expect(screen.getByText("Result details")).toBeInTheDocument();
  });
});
