// @vitest-environment jsdom
/**
 * TDD: TerminalPanel React lifecycle against a fake transport + fake view.
 * Spec: docs/terminal-wterm-tdd-plan.md contract items 9–15.
 */
import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import {
  TerminalPanel,
  type CreateTerminalView,
  type TerminalView,
  type TerminalViewHandlers,
} from "../../src/web/components/TerminalPanel.js";
import type { TerminalTransport } from "../../src/web/components/terminal-transport.js";

// ---- Fakes ---------------------------------------------------------------

class FakeTransport implements TerminalTransport {
  opens: Array<{ sessionId: string; cols: number; rows: number }> = [];
  inputs: Array<{ ptyId: string; data: string }> = [];
  resizes: Array<{ ptyId: string; cols: number; rows: number }> = [];
  closes: string[] = [];
  private dataListeners = new Set<(e: { ptyId: string; seq: number; data: string }) => void>();
  private exitListeners = new Set<(e: { ptyId: string; exitCode: number; signal?: number }) => void>();
  nextPtyId = "pty-1";

  async open(sessionId: string, cols: number, rows: number): Promise<string> {
    this.opens.push({ sessionId, cols, rows });
    return this.nextPtyId;
  }
  input(ptyId: string, data: string): void { this.inputs.push({ ptyId, data }); }
  resize(ptyId: string, cols: number, rows: number): void { this.resizes.push({ ptyId, cols, rows }); }
  close(ptyId: string): void { this.closes.push(ptyId); }
  onData(l: (e: { ptyId: string; seq: number; data: string }) => void): () => void {
    this.dataListeners.add(l); return () => this.dataListeners.delete(l);
  }
  onExit(l: (e: { ptyId: string; exitCode: number; signal?: number }) => void): () => void {
    this.exitListeners.add(l); return () => this.exitListeners.delete(l);
  }
  emitData(e: { ptyId: string; seq: number; data: string }): void { for (const l of [...this.dataListeners]) l(e); }
  emitExit(e: { ptyId: string; exitCode: number; signal?: number }): void { for (const l of [...this.exitListeners]) l(e); }
}

class FakeView implements TerminalView {
  cols = 80;
  rows = 24;
  written: string[] = [];
  focused = 0;
  destroyed = 0;
  handlers: TerminalViewHandlers;
  constructor(public host: HTMLElement, handlers: TerminalViewHandlers) { this.handlers = handlers; }
  async init(): Promise<unknown> { return this; }
  write(data: string): void { this.written.push(data); this.host.textContent = (this.host.textContent ?? "") + data; }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }
  focus(): void { this.focused += 1; }
  destroy(): void { this.destroyed += 1; }
}

let lastView: FakeView | null = null;
const makeCreateView = (): CreateTerminalView => (host, handlers) => {
  lastView = new FakeView(host, handlers);
  return lastView;
};

afterEach(() => { lastView = null; vi.restoreAllMocks(); });

function renderPanel(transport: FakeTransport, active = true) {
  return render(
    <TerminalPanel sessionId="sess-1" transport={transport} active={active} createView={makeCreateView()} />,
  );
}

describe("TerminalPanel", () => {
  it("9. exposes a tabpanel labeled Terminal with the wterm host", () => {
    const t = new FakeTransport();
    renderPanel(t, false);
    expect(screen.getByRole("tabpanel", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByTestId("wterm-root")).toBeInTheDocument();
  });

  it("10. does NOT open a pty until the tab is activated", async () => {
    const t = new FakeTransport();
    const { rerender } = renderPanel(t, false);
    expect(t.opens).toHaveLength(0); // inactive: no shell spawned

    rerender(<TerminalPanel sessionId="sess-1" transport={t} active createView={makeCreateView()} />);
    await waitFor(() => expect(t.opens).toHaveLength(1));
    expect(t.opens[0]).toMatchObject({ sessionId: "sess-1", cols: 80, rows: 24 });
  });

  it("11. renders streamed pty:data into the wterm host", async () => {
    const t = new FakeTransport();
    renderPanel(t);
    await waitFor(() => expect(t.opens).toHaveLength(1));
    act(() => t.emitData({ ptyId: "pty-1", seq: 1, data: "hello-from-shell" }));
    expect(lastView!.written).toContain("hello-from-shell");
    expect(screen.getByTestId("wterm-root")).toHaveTextContent("hello-from-shell");
  });

  it("12. forwards keystrokes as pty:input with exact bytes", async () => {
    const t = new FakeTransport();
    renderPanel(t);
    await waitFor(() => expect(t.opens).toHaveLength(1));
    act(() => lastView!.handlers.onData("ls -la\r"));
    expect(t.inputs).toEqual([{ ptyId: "pty-1", data: "ls -la\r" }]);
  });

  it("13. forwards resize as pty:resize", async () => {
    const t = new FakeTransport();
    renderPanel(t);
    await waitFor(() => expect(t.opens).toHaveLength(1));
    act(() => lastView!.handlers.onResize(120, 40));
    expect(t.resizes).toEqual([{ ptyId: "pty-1", cols: 120, rows: 40 }]);
  });

  it("14. shows an exit banner with a Restart control on pty:exit", async () => {
    const t = new FakeTransport();
    renderPanel(t);
    await waitFor(() => expect(t.opens).toHaveLength(1));
    act(() => t.emitExit({ ptyId: "pty-1", exitCode: 7 }));
    expect(screen.getByRole("status")).toHaveTextContent("Process exited (code 7)");
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  });

  it("15. closes the pty exactly once on unmount", async () => {
    const t = new FakeTransport();
    const { unmount } = renderPanel(t);
    await waitFor(() => expect(t.opens).toHaveLength(1));
    unmount();
    expect(t.closes).toEqual(["pty-1"]);
    expect(lastView!.destroyed).toBe(1);
  });
});
