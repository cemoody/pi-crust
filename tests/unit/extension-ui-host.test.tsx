// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionUiHost } from "../../src/web/components/ExtensionUiHost.js";
import type { ExtensionUiRequest } from "../../src/shared/protocol.js";

function renderHost(requests: ExtensionUiRequest[]) {
  const handlers = {
    onValueResponse: vi.fn(),
    onConfirmResponse: vi.fn(),
    onCancelResponse: vi.fn(),
    onEditorText: vi.fn(),
  };
  render(<ExtensionUiHost requests={requests} {...handlers} />);
  return handlers;
}

describe("ExtensionUiHost", () => {
  it("responds to confirm requests", () => {
    const handlers = renderHost([{ id: "1", method: "confirm", title: "Allow command?", message: "rm?" }]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(handlers.onConfirmResponse).toHaveBeenCalledWith("1", true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(handlers.onConfirmResponse).toHaveBeenCalledWith("1", false);
  });

  it("responds to select requests", () => {
    const handlers = renderHost([{ id: "1", method: "select", title: "Pick", options: ["A", "B"] }]);
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(handlers.onValueResponse).toHaveBeenCalledWith("1", "B");
  });

  it("responds to input and editor requests", () => {
    const handlers = renderHost([
      { id: "input", method: "input", title: "Name", placeholder: "type" },
      { id: "editor", method: "editor", title: "Body", prefill: "old" },
    ]);
    fireEvent.change(screen.getByLabelText("Name value"), { target: { value: "Chris" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Submit" })[0]!);
    expect(handlers.onValueResponse).toHaveBeenCalledWith("input", "Chris");

    fireEvent.change(screen.getByLabelText("Body value"), { target: { value: "new\nbody" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Submit" })[1]!);
    expect(handlers.onValueResponse).toHaveBeenCalledWith("editor", "new\nbody");
  });

  it("cancels dialog requests", () => {
    const handlers = renderHost([{ id: "1", method: "input", title: "Name" }]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.onCancelResponse).toHaveBeenCalledWith("1");
  });

  it("renders notifications, compact statuses, and collapsible widgets", () => {
    renderHost([
      { id: "n", method: "notify", message: "Done", notifyType: "info" },
      { id: "s", method: "setStatus", statusKey: "ext", statusText: "Turn 1" },
      { id: "w", method: "setWidget", widgetKey: "todo", widgetLines: ["one", "two"] },
      { id: "wb", method: "setWidget", widgetKey: "below", widgetLines: ["below"], widgetPlacement: "belowEditor" },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("Done");
    expect(screen.getByRole("region", { name: "Extension statuses" })).toHaveTextContent("Turn 1");

    const todo = screen.getByRole("group", { name: "Widget todo" });
    const todoToggle = screen.getByRole("button", { name: "todo extension widget" });
    expect(todoToggle).toHaveAttribute("aria-expanded", "false");
    expect(todo).toHaveTextContent("one");
    fireEvent.click(todoToggle);
    expect(todoToggle).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByRole("group", { name: "Widget below" })).toHaveTextContent("below");
  });

  it("updates browser title and editor text", () => {
    const handlers = renderHost([
      { id: "t", method: "setTitle", title: "pi - project" },
      { id: "e", method: "set_editor_text", text: "prefill" },
    ]);
    expect(document.title).toBe("pi - project");
    expect(handlers.onEditorText).toHaveBeenCalledWith("prefill");
  });

  it("shows approval inbox for pending dialogs", () => {
    renderHost([{ id: "1", method: "confirm", title: "Dangerous command?" }]);
    expect(screen.getByLabelText("Approval inbox")).toHaveTextContent("Dangerous command?");
  });
});
