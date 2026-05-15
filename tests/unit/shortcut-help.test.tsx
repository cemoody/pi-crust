// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutHelp } from "../../src/web/components/ShortcutHelp.js";

// vite's `define` injects __PI_REMOTE_GIT_SHA__ as a global; tests run under
// vitest which doesn't apply that define, so we declare it via globalThis.
(globalThis as { __PI_REMOTE_GIT_SHA__?: string }).__PI_REMOTE_GIT_SHA__ = "frontendsh4f3";

describe("ShortcutHelp", () => {
  it("opens when ? is pressed outside an input", () => {
    render(<ShortcutHelp />);
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("does not open when ? is pressed inside a textarea", () => {
    render(<><textarea aria-label="something" /><ShortcutHelp /></>);
    fireEvent.keyDown(screen.getByLabelText("something"), { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<ShortcutHelp />);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("closes via the close button", () => {
    render(<ShortcutHelp />);
    fireEvent.keyDown(document.body, { key: "?" });
    fireEvent.click(screen.getByRole("button", { name: "Close shortcuts" }));
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("shows the frontend and backend git SHAs in the dialog", async () => {
    const fetchBackend = vi.fn(async () => ({ gitSha: "backendabc123" }));
    render(<ShortcutHelp fetchBackendInfo={fetchBackend} />);
    fireEvent.keyDown(document.body, { key: "?" });
    // Frontend SHA is injected synchronously and should be visible immediately.
    expect(screen.getByText(/frontendsh4f3/)).toBeInTheDocument();
    // Backend SHA arrives via fetch — wait for it.
    await waitFor(() => expect(screen.getByText(/backendabc123/)).toBeInTheDocument());
    expect(fetchBackend).toHaveBeenCalledOnce();
    // Both labels are visible so the user can tell which is which. Scope
    // to <dt> so we don't strict-mode-collide with the embedded code text.
    const dts = Array.from(document.querySelectorAll(".shortcut-help-shas dt"));
    expect(dts.map((el) => el.textContent)).toEqual(["frontend", "backend"]);
  });

  it("degrades to 'unknown' when the backend fetch fails", async () => {
    const fetchBackend = vi.fn(async () => { throw new Error("down"); });
    render(<ShortcutHelp fetchBackendInfo={fetchBackend} />);
    fireEvent.keyDown(document.body, { key: "?" });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    await waitFor(() => expect(dialog.textContent ?? "").toMatch(/unknown/));
  });

  it("in dev (no __PI_REMOTE_GIT_SHA__ define) the frontend row shows the live backend SHA", async () => {
    // Simulate `vite serve` where the build-time define is omitted: the
    // help dialog should show the backend's live gitSha for BOTH rows,
    // matching the running checkout. This is the fix for 'I merged a PR
    // but the help page still shows the old SHA': in dev, the bundle's
    // baked SHA is meaningless (HMR has replaced modules), so we just
    // mirror the api.
    const prior = (globalThis as { __PI_REMOTE_GIT_SHA__?: string }).__PI_REMOTE_GIT_SHA__;
    delete (globalThis as { __PI_REMOTE_GIT_SHA__?: string }).__PI_REMOTE_GIT_SHA__;
    try {
      const fetchBackend = vi.fn(async () => ({ gitSha: "livesha98e4" }));
      render(<ShortcutHelp fetchBackendInfo={fetchBackend} />);
      fireEvent.keyDown(document.body, { key: "?" });
      // Both rows should eventually show the backend's live SHA. We can't
      // assert with getByText because it'd match multiple elements; instead
      // wait until both <code> tags in .shortcut-help-shas render that value.
      await waitFor(() => {
        const codes = Array.from(document.querySelectorAll(".shortcut-help-shas code"));
        expect(codes).toHaveLength(2);
        expect(codes.every((c) => c.textContent === "livesha98e4")).toBe(true);
      });
    } finally {
      if (prior !== undefined) (globalThis as { __PI_REMOTE_GIT_SHA__?: string }).__PI_REMOTE_GIT_SHA__ = prior;
    }
  });
});
