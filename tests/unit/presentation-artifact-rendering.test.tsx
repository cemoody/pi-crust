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

    fireEvent.click(screen.getByRole("button", { name: "Present deck" }));

    expect(screen.getByRole("dialog", { name: /Executive Signal Brief presentation/ })).toBeInTheDocument();
    expect(screen.getByTestId("artifact-presentation-modal")).toBeInTheDocument();
  });

  it("falls back when the presentation renderer MIME is not enabled", () => {
    render(<MessageTimeline messages={[presentationMessage]} enabledArtifactMimes={[]} />);

    expect(screen.queryByTestId("artifact-presentation")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-fallback")).toHaveTextContent("Presentation fallback");
  });
});
