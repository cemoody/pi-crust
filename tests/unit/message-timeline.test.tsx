// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageTimeline } from "../../src/web/components/MessageTimeline.js";

// jsdom has no layout engine, so we stub element size so the auto-scroll
// math (`scrollHeight - scrollTop - clientHeight`) can be exercised.
function stubScrollGeometry(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
}

// Capture ResizeObserver callbacks so tests can manually "fire" a resize when
// content grows (e.g. simulating streaming tokens being appended).
let resizeCallbacks: ResizeObserverCallback[] = [];
class MockResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {
    resizeCallbacks.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
  }
}

function fireResize() {
  act(() => {
    for (const cb of [...resizeCallbacks]) cb([], {} as ResizeObserver);
  });
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Element.prototype.scrollIntoView = vi.fn();
  resizeCallbacks = [];
  (globalThis as any).ResizeObserver = MockResizeObserver;
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
    // 'private reasoning' now appears in two places: the collapsed body
    // and the inline summary preview. Both should disappear when
    // thinking is hidden.
    expect(screen.getAllByText("private reasoning").length).toBeGreaterThan(0);

    rerender(<MessageTimeline hideThinking messages={[{
      id: "a1",
      role: "assistant",
      text: "answer",
      thinking: "private reasoning",
    }]} />);
    expect(screen.queryByText("private reasoning")).not.toBeInTheDocument();
  });

  it("renders thinking inside a <details> that is collapsed by default", () => {
    // Bug report: thinking blocks were rendered as plain Markdown
    // paragraphs in the assistant bubble. With the pipeline fix they
    // come through as TimelineMessage.thinking and MessageTimeline
    // already wraps them in a <details>. This test pins that the
    // <details> is NOT initially open, mirroring how tool calls also
    // start collapsed on mobile so the body stays readable.
    const { container } = render(<MessageTimeline messages={[{
      id: "a1",
      role: "assistant",
      text: "the answer",
      thinking: "Exploring BigQuery options\n\nI'm considering...",
    }]} />);
    const details = container.querySelector("details.thinking-block");
    expect(details, "thinking should render inside <details className='thinking-block'>").not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    // And the visible bubble text must not contain the thinking text.
    expect(screen.getByText("the answer")).toBeInTheDocument();
    const bubble = container.querySelector(".message-bubble");
    expect(bubble?.textContent ?? "").not.toContain("Exploring BigQuery options");
  });

  it("renders the thinking block with the same tool-card summary structure", () => {
    // Visual parity ask: thinking should look like a tool call — same
    // compact row with a status icon + verb + status-text — not a bare
    // 'Thinking' link.
    const { container } = render(<MessageTimeline messages={[{
      id: "a1", role: "assistant", text: "reply",
      thinking: "weighing options",
    }]} />);
    const details = container.querySelector("details.thinking-block");
    expect(details).not.toBeNull();
    // Adopts the .tool-card class so the existing tool-card CSS applies.
    expect(details!.classList.contains("tool-card")).toBe(true);
    // Has the same summary anatomy as a real tool call.
    expect(details!.querySelector("summary .tool-icon")).not.toBeNull();
    expect(details!.querySelector("summary .tool-line")).not.toBeNull();
  });

  it("renders a one-line preview of the thinking content in the summary row", () => {
    // UX ask: a fully collapsed 'Thought' row hides what the model was
    // actually reasoning about. Mirror how tool calls expose a short
    // .tool-args preview after the verb (e.g. 'Read · /path/to/file')
    // so users get a glance at the first line without expanding.
    const { container } = render(<MessageTimeline messages={[{
      id: "a1", role: "assistant", text: "reply",
      thinking: "Considering whether to use BigQuery\n\nNext step would be...",
    }]} />);
    const preview = container.querySelector(
      "details.thinking-block summary .tool-line .thinking-preview",
    );
    expect(preview, "summary should include a .thinking-preview span").not.toBeNull();
    expect(preview!.textContent ?? "").toBe("Considering whether to use BigQuery");
    // Adopts the .tool-args class so it picks up the existing
    // lower-priority styling (secondary color, ellipsis on overflow).
    expect(preview!.classList.contains("tool-args")).toBe(true);
  });

  it("uses a lightbulb glyph for the thinking-card status icon", () => {
    // Visual: thinking should be marked by a 💡 (or comparable bulb) glyph
    // rather than the previous ✦ / star so it reads as 'idea / thought',
    // matching how tool cards have a status ✓ / ✕ in the same slot.
    const { container } = render(<MessageTimeline messages={[{
      id: "a1", role: "assistant", text: "reply",
      thinking: "weighing options",
    }]} />);
    const icon = container.querySelector("details.thinking-block summary .tool-icon");
    expect(icon, "thinking-card should have a .tool-icon span").not.toBeNull();
    expect(icon!.textContent ?? "").toMatch(/💡/);
  });

  it("does not render a leading disclosure chevron on tool or thinking cards", () => {
    // User feedback: 'remove the leading bullet before tool / thought
    // calls — it's silly to have it next to the ✓ status icon'. The
    // status icon + the body popping out below are enough indication of
    // open/closed; the extra glyph just adds noise to the row.
    const { container } = render(<MessageTimeline messages={[
      { id: "a1", role: "assistant", text: "hi", thinking: "thought" },
      { id: "t1", role: "tool", text: "output",
        tool: { id: "x", name: "bash", args: { command: "ls -la" }, status: "success", output: "a\nb\nc" } },
    ]} />);
    expect(container.querySelectorAll("summary .disclosure")).toHaveLength(0);
    // Sanity: the rows are still expandable via the native <details>.
    const thinkingDetails = container.querySelector("details.thinking-block") as HTMLDetailsElement;
    const toolDetails = container.querySelector("details.tool-card:not(.thinking-block)") as HTMLDetailsElement;
    expect(thinkingDetails.open).toBe(false);
    expect(toolDetails.open).toBe(false);
    thinkingDetails.open = true;
    toolDetails.open = true;
    expect(thinkingDetails.open).toBe(true);
    expect(toolDetails.open).toBe(true);
  });

  it("shows the input command (bash) in a labeled box when a tool card is expanded", () => {
    const { container } = render(<MessageTimeline messages={[
      { id: "t1", role: "tool", text: "hello world",
        tool: { id: "x", name: "bash",
                args: { command: "echo 'hello world' && date" },
                status: "success", output: "hello world\nWed May 14 21:00:00 UTC 2026" } },
    ]} />);
    const details = container.querySelector("details.tool-card") as HTMLDetailsElement;
    // Force-open so the body renders even though it would default to
    // collapsed for a successful call.
    details.open = true;
    // Re-query the now-rendered body content. Native <details> renders
    // children regardless of open state in jsdom, so we can assert the
    // input box exists.
    const input = container.querySelector(".tool-input");
    expect(input, "expanded tool card should show an .tool-input box").not.toBeNull();
    expect(input!.textContent ?? "").toContain("echo 'hello world' && date");
  });

  it("prefers elapsed duration over 'done' even after a reload (when the tool carries timestamps)", () => {
    // Reload bug: after history reload tool entries lost their
    // startedAt/completedAt and the row reverted to 'done'. The pipeline
    // (pirpc-pi-adapter → toDashboardMessages → toTimelineMessage) now
    // plumbs both timestamps through SessionToolDetails so the row
    // always shows the real duration when we have the data.
    const start = 1778800000000;
    render(<MessageTimeline messages={[{
      id: "t1", role: "tool", text: "hello",
      tool: { id: "x", name: "bash", args: { command: "echo hello" },
              status: "success", output: "hello",
              startedAt: start, completedAt: start + 12_000 },
    }]} />);
    expect(screen.getByText("12 sec")).toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();
  });

  it("formats elapsed durations as '3 sec' / '5 min' (not 'done' or bare units)", () => {
    const start = 1700000000000;
    render(<MessageTimeline messages={[
      { id: "t1", role: "tool", text: "",
        tool: { id: "a", name: "bash", args: { command: "echo a" }, status: "success", output: "a",
                startedAt: start, completedAt: start + 3_400 } },
      { id: "t2", role: "tool", text: "",
        tool: { id: "b", name: "bash", args: { command: "echo b" }, status: "success", output: "b",
                startedAt: start, completedAt: start + 5 * 60_000 } },
      { id: "t3", role: "tool", text: "",
        tool: { id: "c", name: "bash", args: { command: "echo c" }, status: "success", output: "c",
                startedAt: start, completedAt: start + 750 } },
    ]} />);
    expect(screen.getByText("3 sec")).toBeInTheDocument();
    expect(screen.getByText("5 min")).toBeInTheDocument();
    // Sub-second times still distinguishable but not as 'done'.
    expect(screen.queryByText("done")).not.toBeInTheDocument();
    expect(screen.getByText("750 ms")).toBeInTheDocument();
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

  describe("sticky auto-scroll", () => {
    function getScrollContainer(): HTMLElement {
      const el = document.querySelector(".message-timeline") as HTMLElement | null;
      if (!el) throw new Error("message timeline container missing");
      return el;
    }

    it("exposes data-pinned='true' on the timeline container while the user is at the bottom", () => {
      // Used by sibling CSS to fade the prompt-composer's top gradient out
      // when there's no scrolling content sliding under it to mask.
      render(<MessageTimeline autoScroll messages={[{ id: "a1", role: "assistant", text: "hi" }]} />);
      const container = getScrollContainer();
      expect(container.getAttribute("data-pinned")).toBe("true");
    });

    it("flips data-pinned to 'false' once the user scrolls away from the bottom, and back to 'true' on re-pin", () => {
      render(<MessageTimeline autoScroll messages={[{ id: "a1", role: "assistant", text: "hi" }]} />);
      const container = getScrollContainer();
      expect(container.getAttribute("data-pinned")).toBe("true");

      // Scroll far up (well past the existing 80 px pin threshold).
      stubScrollGeometry(container, { scrollHeight: 2000, clientHeight: 500 });
      container.scrollTop = 50;
      act(() => { fireEvent.scroll(container); });
      expect(container.getAttribute("data-pinned")).toBe("false");

      // Scroll back to the bottom; the attribute flips back.
      container.scrollTop = container.scrollHeight - container.clientHeight;
      act(() => { fireEvent.scroll(container); });
      expect(container.getAttribute("data-pinned")).toBe("true");
    });

    it("keeps scrolling to bottom while the user is pinned near the bottom", () => {
      const { rerender } = render(
        <MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "first" }]} />,
      );
      const container = getScrollContainer();
      stubScrollGeometry(container, { scrollHeight: 1000, clientHeight: 500 });
      // Simulate: user is at the very bottom (500 + 500 = 1000).
      container.scrollTop = 500;

      // New token streams in -> content grows.
      stubScrollGeometry(container, { scrollHeight: 1200, clientHeight: 500 });
      rerender(<MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "first second" }]} />);
      fireResize();

      expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
      expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();
    });

    it("does not auto-scroll while the user has scrolled up to read history", () => {
      const { rerender } = render(
        <MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "first" }]} />,
      );
      const container = getScrollContainer();
      stubScrollGeometry(container, { scrollHeight: 2000, clientHeight: 500 });
      // User scrolls far away from the bottom.
      container.scrollTop = 100;
      act(() => { fireEvent.scroll(container); });

      // Capture, then simulate streaming content growth.
      const previousScrollTop = container.scrollTop;
      stubScrollGeometry(container, { scrollHeight: 2400, clientHeight: 500 });
      rerender(<MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "first lots more text" }]} />);
      fireResize();

      expect(container.scrollTop).toBe(previousScrollTop);
    });

    it("shows a 'jump to latest' button once the user scrolls away from the bottom", () => {
      render(<MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "hi" }]} />);
      const container = getScrollContainer();
      stubScrollGeometry(container, { scrollHeight: 2000, clientHeight: 500 });
      container.scrollTop = 50;
      act(() => { fireEvent.scroll(container); });

      expect(screen.getByRole("button", { name: /jump to latest/i })).toBeInTheDocument();
    });

    it("re-pins and scrolls to bottom when 'jump to latest' is clicked", () => {
      const { rerender } = render(
        <MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "hi" }]} />,
      );
      const container = getScrollContainer();
      stubScrollGeometry(container, { scrollHeight: 2000, clientHeight: 500 });
      container.scrollTop = 50;
      act(() => { fireEvent.scroll(container); });

      fireEvent.click(screen.getByRole("button", { name: /jump to latest/i }));

      expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
      expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();

      // And subsequent streaming updates resume auto-scrolling.
      stubScrollGeometry(container, { scrollHeight: 2200, clientHeight: 500 });
      rerender(<MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "hi more" }]} />);
      fireResize();
      expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
    });

    it("re-pins when the user manually scrolls back near the bottom", () => {
      const { rerender } = render(
        <MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "hi" }]} />,
      );
      const container = getScrollContainer();
      stubScrollGeometry(container, { scrollHeight: 2000, clientHeight: 500 });
      container.scrollTop = 50;
      act(() => { fireEvent.scroll(container); });
      expect(screen.getByRole("button", { name: /jump to latest/i })).toBeInTheDocument();

      // User scrolls back down within the pin threshold of the bottom.
      container.scrollTop = 1490; // distance = 2000 - 1490 - 500 = 10
      act(() => { fireEvent.scroll(container); });

      expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();

      stubScrollGeometry(container, { scrollHeight: 2200, clientHeight: 500 });
      rerender(<MessageTimeline autoScroll streaming messages={[{ id: "a1", role: "assistant", text: "hi more" }]} />);
      fireResize();
      expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
    });
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
    // No *output* <pre> while running. (The .tool-input <pre> showing the
    // input path is fine — that's intentional and covered separately.)
    expect(card.querySelector("pre.tool-output")).toBeNull();
  });

  it("renders orphan tool-result text as preformatted output instead of markdown", () => {
    render(<MessageTimeline messages={[{
      id: "t-orphan",
      role: "tool",
      text: "> pi-crust@0.0.0 typecheck tsc --noEmit\nD file.ts M other.ts\ncreate mode 100644 package.json",
    }]} />);

    const orphan = screen.getByLabelText("tool result");
    expect(orphan).toBeInTheDocument();
    const pre = orphan.querySelector("pre");
    expect(pre).toHaveTextContent("> pi-crust@0.0.0 typecheck tsc --noEmit");
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
