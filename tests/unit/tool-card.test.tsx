// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCard, ToolList } from "../../src/web/components/ToolCard.js";
import { ToolOutputRenderer } from "../../src/web/components/tool-output-renderer.js";

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("ToolCard", () => {
  it("renders a running bash command and streamed output", () => {
    render(<ToolCard expanded tool={{ id: "1", name: "bash", status: "running", args: { command: "echo hi" }, output: "hi" }} />);
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("echo hi")).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
  });

  it("renders read output with file path", () => {
    render(<ToolCard expanded tool={{ id: "1", name: "read", status: "success", args: { path: "src/a.ts" }, output: "const a = 1;" }} />);
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("const a = 1;")).toBeInTheDocument();
  });

  it("renders edit output as a diff", () => {
    render(<ToolCard expanded tool={{ id: "1", name: "edit", status: "success", args: {}, output: "+added\n-removed\n context" }} />);
    expect(screen.getByText("+added")).toHaveClass("added");
    expect(screen.getByText("-removed")).toHaveClass("removed");
  });

  it("renders grep, find, and ls as lists", () => {
    const { rerender } = render(<ToolCard expanded tool={{ id: "1", name: "grep", status: "success", args: {}, output: "a.ts:1:match" }} />);
    expect(screen.getByText("a.ts:1:match")).toBeInTheDocument();

    rerender(<ToolCard expanded tool={{ id: "2", name: "find", status: "success", args: {}, output: "a.ts\nb.ts" }} />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();

    rerender(<ToolCard expanded tool={{ id: "3", name: "ls", status: "success", args: {}, output: "package.json" }} />);
    expect(screen.getByText("package.json")).toBeInTheDocument();
  });

  it("renders unknown tools with arguments and result text", () => {
    render(<ToolCard expanded tool={{ id: "1", name: "custom_tool", status: "error", args: { value: 1 }, output: "failed" }} />);
    expect(screen.getByText(/"value": 1/)).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("renders write output through the extracted output renderer", () => {
    render(<ToolOutputRenderer tool={{ id: "1", name: "write", status: "success", args: { file: "notes.txt" }, output: "written" }} />);
    expect(screen.getByText("Written file:")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("written")).toBeInTheDocument();
  });

  it("copies and links full output when available", () => {
    render(<ToolCard expanded tool={{ id: "1", name: "bash", status: "success", args: {}, output: "copy this", truncated: true, fullOutputUrl: "/logs/1" }} />);
    expect(screen.getByText("truncated")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("copy this");
    expect(screen.getByRole("link", { name: "Download full output" })).toHaveAttribute("href", "/logs/1");
  });

  it("supports expand all and collapse all", () => {
    render(<ToolList tools={[{ id: "1", name: "bash", status: "success", args: { command: "echo hi" }, output: "hi" }]} />);
    expect(screen.getByText("hi")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("hi")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByText("hi")).toBeInTheDocument();
  });

  it("keeps error tools expanded by default", () => {
    render(<ToolList tools={[{ id: "1", name: "bash", status: "error", args: { command: "bad" }, output: "boom" }]} collapseSuccessfulByDefault />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
