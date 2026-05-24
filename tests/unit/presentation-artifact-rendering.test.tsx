// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageTimeline } from "../../src/web/components/MessageTimeline.js";
import { PRESENTATION_MIME } from "../../src/presentations/schema.js";

const presentationMessage = {
  id: "m1",
  role: "custom" as const,
  text: "Presentation generated",
  customType: "artifact",
  artifact: {
    artifactGroupId: "deck-1",
    caption: "Presentation deck",
    artifacts: [{
      mime: PRESENTATION_MIME,
      spec: {
        title: "Executive Signal Brief",
        slides: [
          { title: "Executive Signal Brief", subtitle: "Executive update" },
          { title: "What changed", bullets: ["Permits accelerated", "Weather risk shifted east"] },
        ],
      },
    }, { mime: "text/plain", text: "Presentation fallback" }],
  },
};

describe("presentation artifact rendering", () => {
  it("renders a deck card with preview and present modal from multi-MIME artifacts", () => {
    render(<MessageTimeline messages={[presentationMessage]} />);

    expect(screen.getByTestId("artifact-presentation")).toBeInTheDocument();
    expect(screen.getAllByText("Executive Signal Brief").length).toBeGreaterThan(0);
    expect(screen.getByText("2 slides")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-presentation-preview")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));

    expect(screen.getByRole("dialog", { name: /Executive Signal Brief presentation/ })).toBeInTheDocument();
    expect(screen.getByTestId("artifact-presentation-modal")).toBeInTheDocument();
  });

  it("falls back when the presentation renderer MIME is not enabled", () => {
    render(<MessageTimeline messages={[presentationMessage]} enabledArtifactMimes={[]} />);

    expect(screen.queryByTestId("artifact-presentation")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-fallback")).toHaveTextContent("Presentation fallback");
  });

  it("renders an inline error card (and does NOT throw) when a slide image has an unsafe absolute path", () => {
    const unsafeMessage = {
      ...presentationMessage,
      id: "m-unsafe",
      artifact: {
        ...presentationMessage.artifact,
        artifacts: [{
          mime: PRESENTATION_MIME,
          spec: {
            title: "Brainco Signals",
            slides: [
              { title: "Cover", image: "/tmp/brainco_signals.png" },
            ],
          },
        }],
      },
    };

    // Before the fix this throws synchronously out of compileRevealHtml and
    // blanks the whole React tree. After the fix it renders a localized
    // alert card with the error message and a fallback outline.
    expect(() => render(<MessageTimeline messages={[unsafeMessage]} />)).not.toThrow();
    expect(screen.getByTestId("artifact-presentation")).toHaveAttribute("role", "alert");
    expect(screen.getByText(/Could not render presentation preview/)).toBeInTheDocument();
  });

  // TDD characterization tests added to pin down behavior before extracting
  // PresentationArtifactCard into its own file. These exercise code paths
  // the older happy/fallback tests don't reach.

  it("renders an 'Invalid presentation' alert when the deck input fails coercion", () => {
    // A presentation artifact whose spec is a primitive (or missing
    // slides[]) fails coercePresentationDeck. The card renders a role=alert
    // section with the parse error inside a <pre>, not the normal preview.
    const invalid = {
      ...presentationMessage,
      id: "m-bad",
      artifact: {
        ...presentationMessage.artifact,
        artifacts: [{ mime: PRESENTATION_MIME, spec: "not a deck" }],
      },
    };
    render(<MessageTimeline messages={[invalid]} />);
    const alert = screen.getByText("Invalid presentation").closest("section");
    expect(alert).not.toBeNull();
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert?.querySelector("pre")?.textContent ?? "").not.toBe("");
  });

  it("pluralizes the slide count: '1 slide' (no 's') for a one-slide deck", () => {
    const single = {
      ...presentationMessage,
      id: "m-one",
      artifact: {
        ...presentationMessage.artifact,
        artifacts: [{
          mime: PRESENTATION_MIME,
          spec: { title: "One Slider", slides: [{ title: "Only slide" }] },
        }],
      },
    };
    render(<MessageTimeline messages={[single]} />);
    expect(screen.getByText("1 slide")).toBeInTheDocument();
    expect(screen.queryByText("1 slides")).not.toBeInTheDocument();
  });
});
