// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider, useNotifications } from "../../src/web/components/notifications.js";

function Harness({ onReady }: { onReady: (api: ReturnType<typeof useNotifications>) => void }) {
  const api = useNotifications();
  onReady(api);
  return null;
}

function renderHarness() {
  const ref: { current: ReturnType<typeof useNotifications> | null } = { current: null };
  render(
    <NotificationsProvider>
      <Harness onReady={(api) => { ref.current = api; }} />
    </NotificationsProvider>,
  );
  if (!ref.current) throw new Error("harness did not capture api");
  return ref.current;
}

describe("NotificationsProvider", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("renders an info toast and auto-dismisses after the default 4s", () => {
    const api = renderHarness();
    act(() => { api.notify({ message: "Saved" }); });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3_999); });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("auto-dismisses error toasts after the 8s default", () => {
    const api = renderHarness();
    act(() => { api.notify({ kind: "error", message: "Boom" }); });
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
    act(() => { vi.advanceTimersByTime(7_999); });
    expect(screen.getByText("Boom")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.queryByText("Boom")).toBeNull();
  });

  it("keeps error toasts open when persistent: true is set", () => {
    const api = renderHarness();
    act(() => { api.notify({ kind: "error", message: "Sticky", persistent: true }); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("Sticky")).toBeInTheDocument();
  });

  it("auto-dismisses warning toasts after 6s", () => {
    const api = renderHarness();
    act(() => { api.notify({ kind: "warning", message: "Heads up" }); });
    act(() => { vi.advanceTimersByTime(5_999); });
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.queryByText("Heads up")).toBeNull();
  });

  it("supports manual dismiss via the close button", () => {
    const api = renderHarness();
    act(() => { api.notify({ kind: "error", message: "Persistent" }); });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Persistent")).toBeNull();
  });

  it("replaces a toast in place when notify() is called with the same id", () => {
    const api = renderHarness();
    act(() => { api.notify({ id: "x", message: "first" }); });
    expect(screen.getByText("first")).toBeInTheDocument();
    act(() => { api.notify({ id: "x", message: "second" }); });
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("treats persistent: true as no auto-dismiss", () => {
    const api = renderHarness();
    act(() => { api.notify({ message: "stays", persistent: true }); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("stays")).toBeInTheDocument();
  });

  it("dismiss() removes a toast programmatically", () => {
    const api = renderHarness();
    let id = "";
    act(() => { id = api.notify({ kind: "error", message: "x" }); });
    act(() => { api.dismiss(id); });
    expect(screen.queryByText("x")).toBeNull();
  });
});
