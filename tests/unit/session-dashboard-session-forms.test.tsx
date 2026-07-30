// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  InlineNameInput,
  NewSessionDialog,
  RenameSessionForm,
} from "../../src/web/components/session-dashboard-session-forms.js";

describe("session dashboard session forms", () => {
  it("commits a non-empty inline name on blur and resets the draft for another session", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <InlineNameInput sessionId="one" currentName="Untitled session" onCommit={onCommit} />,
    );
    const input = screen.getByLabelText("Name this session");

    fireEvent.change(input, { target: { value: "  Project plan  " } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("Project plan");

    fireEvent.change(input, { target: { value: "unfinished" } });
    rerender(<InlineNameInput sessionId="two" currentName="Second" onCommit={onCommit} />);
    expect(input).toHaveValue("");
  });

  it("saves a rename on Enter and cancels it on Escape", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<RenameSessionForm initialName="Before" onSave={onSave} onCancel={onCancel} />);
    const input = screen.getByLabelText("Session name");

    fireEvent.change(input, { target: { value: "After" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onSave).toHaveBeenCalledWith("After");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps the new-session dialog open and reports failed creation", async () => {
    const onCreate = vi.fn(async () => { throw new Error("CWD denied"); });
    render(<NewSessionDialog initialCwd="/workspace" onCreate={onCreate} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("New session name"), { target: { value: "  Debug  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ cwd: "/workspace", sessionName: "Debug" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("CWD denied");
    expect(screen.getByRole("dialog", { name: "Create new session" })).not.toHaveAttribute("aria-busy", "true");
  });

  it("blocks cancellation while a new session is being created", async () => {
    let resolveCreation!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => { resolveCreation = resolve; }));
    const onCancel = vi.fn();
    render(<NewSessionDialog initialCwd="/workspace" onCreate={onCreate} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).not.toHaveBeenCalled();

    resolveCreation();
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false"));
  });
});
