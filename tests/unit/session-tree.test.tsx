// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionTree, type SessionTreeEntry } from "../../src/web/components/SessionTree.js";

const entries: SessionTreeEntry[] = [
  { id: "u1", parentId: null, role: "user", text: "first prompt", label: "start" },
  { id: "a1", parentId: "u1", role: "assistant", text: "answer" },
  { id: "t1", parentId: "a1", role: "tool", text: "bash output" },
  { id: "u2", parentId: "t1", role: "user", text: "second prompt" },
  { id: "s1", parentId: "u2", role: "summary", text: "branch summary" },
];

function renderTree() {
  const handlers = { onNavigate: vi.fn(), onRestoreUserMessage: vi.fn(), onLabel: vi.fn(), onFork: vi.fn(), onClone: vi.fn() };
  render(<SessionTree entries={entries} currentLeafId="u2" {...handlers} />);
  return handlers;
}

describe("SessionTree", () => {
  it("renders tree entries and highlights current leaf", () => {
    renderTree();
    expect(screen.getByText(/first prompt/)).toBeInTheDocument();
    expect(screen.getByText(/second prompt/)).toHaveAttribute("aria-current", "true");
  });

  it("filters user-only, no-tools, labeled-only, and all", () => {
    renderTree();
    fireEvent.change(screen.getByLabelText("Tree filter"), { target: { value: "user-only" } });
    expect(screen.getByText(/first prompt/)).toBeInTheDocument();
    expect(screen.queryByText(/answer/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tree filter"), { target: { value: "no-tools" } });
    expect(screen.queryByText(/bash output/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tree filter"), { target: { value: "labeled-only" } });
    expect(screen.getByText(/start/)).toBeInTheDocument();
    expect(screen.queryByText(/second prompt/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tree filter"), { target: { value: "all" } });
    expect(screen.getByText(/bash output/)).toBeInTheDocument();
  });

  it("selects entries, labels, clears labels, and forks", () => {
    const handlers = renderTree();
    fireEvent.click(screen.getByText(/answer/));
    expect(screen.getByLabelText("Tree entry details")).toHaveTextContent("answer");
    fireEvent.change(screen.getByLabelText("Entry label"), { target: { value: "checkpoint" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear label" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(handlers.onLabel).toHaveBeenCalledWith("a1", "checkpoint");
    expect(handlers.onLabel).toHaveBeenCalledWith("a1", undefined);
    expect(handlers.onFork).toHaveBeenCalledWith("a1");
  });

  it("navigates to user entry and restores text", () => {
    const handlers = renderTree();
    fireEvent.click(screen.getByText(/second prompt/));
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(handlers.onRestoreUserMessage).toHaveBeenCalledWith("second prompt");
    expect(handlers.onNavigate).toHaveBeenCalledWith("u2", { summary: "none" });
  });

  it("navigates with custom branch summary instructions", () => {
    const handlers = renderTree();
    fireEvent.click(screen.getByText(/answer/));
    fireEvent.click(screen.getByLabelText("custom"));
    fireEvent.change(screen.getByLabelText("Custom summary instructions"), { target: { value: "focus on files" } });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(handlers.onRestoreUserMessage).not.toHaveBeenCalled();
    expect(handlers.onNavigate).toHaveBeenCalledWith("a1", { summary: "custom", customInstructions: "focus on files" });
  });

  it("clones current branch", () => {
    const handlers = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    expect(handlers.onClone).toHaveBeenCalled();
  });
});
