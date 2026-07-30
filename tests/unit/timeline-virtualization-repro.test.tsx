// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageTimeline, type TimelineMessage } from "../../src/web/components/MessageTimeline.js";

/**
 * Deterministic long-history repro / performance guard.
 *
 * This deliberately has no server dependency. It models ten 100-message
 * history pages already loaded in memory, then prepends two more pages as the
 * load-older path does. jsdom has no layout, so scroll geometry is fixed to
 * the same conservative 156px per-turn estimate used before a variable-height
 * turn reports its real measurement.
 */
const ROW_HEIGHT = 156;

function history(from: number, to: number): TimelineMessage[] {
  return Array.from({ length: to - from }, (_, offset) => {
    const index = from + offset;
    // Every record is a user turn, deliberately producing the maximum number
    // of turn wrappers (the worst case for DOM/card growth).
    return { id: `history-${index}`, role: "user" as const, text: `history marker ${index}` };
  });
}

function setGeometry(el: HTMLElement, geometry: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
  });
}

describe("MessageTimeline variable-height virtualization", () => {
  it("keeps DOM/card count bounded after many pages while preserving the visible row and top-edge pagination", async () => {
    const onLoadOlder = vi.fn();
    const initial = history(200, 1_200); // ten 100-record pages already loaded
    const { rerender, container } = render(
      <MessageTimeline messages={initial} hasMoreOlder onLoadOlder={onLoadOlder} autoScroll={false} />,
    );
    const timeline = container.querySelector(".message-timeline") as HTMLElement;
    const geometry = { scrollHeight: initial.length * ROW_HEIGHT, clientHeight: 600 };
    setGeometry(timeline, geometry);

    // A middle row remains discoverable, but only the viewport + overscan is
    // mounted. Pre-optimization this assertion rendered all 1,000 cards.
    act(() => {
      timeline.scrollTop = 500 * ROW_HEIGHT;
      fireEvent.scroll(timeline);
    });
    await waitFor(() => expect(screen.getByText("history marker 700")).toBeInTheDocument());
    const boundedCards = container.querySelectorAll(".message-card, .tool-card").length;
    expect(boundedCards).toBeLessThanOrEqual(25);
    expect(container.querySelectorAll(".timeline-turn").length).toBeLessThanOrEqual(25);
    expect(container.querySelector("[role=group][aria-label*='Messages']")).toBeInTheDocument();

    // Scroll to the top as a user would to ask SessionDashboard for an older
    // page. The affordance remains present and the callback still fires.
    act(() => {
      timeline.scrollTop = 0;
      fireEvent.scroll(timeline);
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("timeline-older-loader")).toBeInTheDocument();

    // Model the dashboard prepend. Scroll restoration keeps history-200 (the
    // row that was visible at the old top) visible rather than jumping to the
    // newly inserted history-0 page.
    const older = history(0, 200);
    geometry.scrollHeight = (older.length + initial.length) * ROW_HEIGHT;
    rerender(<MessageTimeline messages={[...older, ...initial]} hasMoreOlder={false} loadingOlder={false} autoScroll={false} />);
    await waitFor(() => {
      expect(timeline.scrollTop).toBe(older.length * ROW_HEIGHT);
      expect(screen.getByText("history marker 200")).toBeInTheDocument();
    });
    expect(container.querySelectorAll(".message-card, .tool-card").length).toBeLessThanOrEqual(25);
  });
});
