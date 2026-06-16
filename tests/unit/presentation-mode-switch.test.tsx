// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageTimeline } from "../../src/web/components/MessageTimeline.js";
import { PRESENTATION_MIME } from "../../src/presentations/schema.js";

const DECK_ID = "switch-deck";
const SESSION_ID = "session-switch";

function messageWithDeck() {
  return {
    id: "m1",
    role: "custom" as const,
    text: "Presentation generated",
    customType: "artifact",
    artifact: {
      artifactGroupId: "deck-1",
      caption: "Presentation deck",
      artifacts: [
        {
          mime: PRESENTATION_MIME,
          spec: {
            id: DECK_ID,
            title: "Switch Deck",
            slides: [{ title: "One", bullets: ["a"] }, { title: "Two", bullets: ["b"] }],
          },
        },
        { mime: "text/plain", text: "fallback" },
      ],
    },
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function openModal() {
  render(<MessageTimeline messages={[messageWithDeck()]} sessionId={SESSION_ID} />);
  await act(async () => { await flush(); });
  fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
  return await screen.findByTestId("artifact-presentation-modal");
}

describe("PresentationArtifactCard — single Edit|Present mode switch", () => {
  it("renders one segmented switch instead of two separate buttons", async () => {
    await openModal();
    const sw = document.querySelector(".presentation-mode-switch");
    expect(sw).toBeInTheDocument();
    const labels = Array.from(sw!.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Edit", "Present"]);
    // The old standalone "Presentation mode" button is gone.
    expect(screen.queryByRole("button", { name: "Presentation mode" })).toBeNull();
  });

  it("marks Present active by default and Edit active after clicking Edit", async () => {
    await openModal();
    const editBtn = screen.getByRole("button", { name: "Edit" });
    const presentBtn = screen.getByRole("button", { name: "Present" });
    expect(presentBtn).toHaveClass("is-active");
    expect(editBtn).not.toHaveClass("is-active");
    fireEvent.click(editBtn);
    await waitFor(() => expect(editBtn).toHaveClass("is-active"));
    expect(presentBtn).not.toHaveClass("is-active");
  });

  it("entering Present hides the toolbar and exposes a floating Edit swap-back", async () => {
    await openModal();
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    await waitFor(() => {
      expect(document.querySelector(".presentation-modal-presenting")).toBeInTheDocument();
    });
    // Immersive mode shows a floating Edit affordance so the single control is
    // bidirectional, plus the exit button — but no full toolbar switch.
    expect(document.querySelector(".presentation-modal-swap-edit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exit presentation mode" })).toBeInTheDocument();
    expect(document.querySelector(".presentation-modal-toolbar")).toBeNull();
  });
});
