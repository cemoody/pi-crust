// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectExplorer } from "../../src/web/components/ProjectExplorer.js";

function renderExplorer() {
  const onCreateWorktree = vi.fn();
  render(<ProjectExplorer
    files={[{ path: "src/app.ts", kind: "file", content: "const app = true;" }, { path: "README.md", kind: "file", content: "# Hello" }, { path: "image.png", kind: "file" }]}
    gitFiles={[{ path: "src/app.ts", status: "M", diff: "+new\n-old" }]}
    readFiles={["README.md"]}
    modifiedFiles={["src/app.ts"]}
    onCreateWorktree={onCreateWorktree}
  />);
  return { onCreateWorktree };
}

describe("ProjectExplorer", () => {
  it("lists and searches project files", () => {
    renderExplorer();
    expect(screen.getByLabelText("Project files")).toHaveTextContent("src/app.ts");
    fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "read" } });
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByLabelText("Project files")).not.toHaveTextContent("src/app.ts");
  });

  it("opens file viewer and markdown preview", () => {
    renderExplorer();
    fireEvent.click(screen.getByText("README.md"));
    expect(screen.getByLabelText("File viewer")).toHaveTextContent("# Hello");
    expect(screen.getByLabelText("Markdown preview")).toHaveTextContent("# Hello");
  });

  it("shows tracked files and git diff", () => {
    renderExplorer();
    expect(screen.getByLabelText("Session file tracking")).toHaveTextContent("README.md");
    expect(screen.getByLabelText("Session file tracking")).toHaveTextContent("src/app.ts");
    expect(screen.getByLabelText("Git status")).toHaveTextContent("M src/app.ts");
    expect(screen.getByText(/\+new/)).toBeInTheDocument();
  });

  it("creates a worktree", () => {
    const { onCreateWorktree } = renderExplorer();
    fireEvent.change(screen.getByLabelText("Worktree name"), { target: { value: "feature-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    expect(onCreateWorktree).toHaveBeenCalledWith("feature-x");
  });
});
