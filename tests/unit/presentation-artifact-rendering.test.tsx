// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function truncatedPresentationToolMessage(artifactUrl = "/api/sessions/s1/messages/m-tool/artifact") {
  return {
    id: "m-tool",
    role: "tool" as const,
    text: "Displayed presentation deck",
    tool: {
      id: "tool-1",
      name: "show_presentation",
      args: {},
      status: "success" as const,
      output: "Displayed presentation deck",
      artifact: {
        kind: "presentation",
        title: "Lazy Tool Deck",
        artifactTruncated: true,
        artifactFullBytes: 11_000_000,
        artifactUrl,
        data: { __omitted: true },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("lazy-loads a truncated presentation tool artifact and renders it inline", async () => {
    const fullArtifact = {
      version: 1,
      kind: "presentation",
      title: "Lazy Tool Deck",
      data: {
        title: "Lazy Tool Deck",
        slides: [
          { title: "Lazy Tool Deck", subtitle: "Loaded after timeline bootstrap" },
          { title: "Details", bullets: ["Fetched separately", "Rendered inline"] },
        ],
      },
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => fullArtifact,
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<MessageTimeline messages={[truncatedPresentationToolMessage()]} />);

    expect(screen.getByText(/Loading artifact \(10\.5 MB\)/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/messages/m-tool/artifact"));
    expect(await screen.findByText("2 slides")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-presentation-preview")).toBeInTheDocument();
  });

  it("defers truncated tool artifacts in browsers until visible or manually loaded", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds: readonly number[] = [];
      observe() { /* leave non-intersecting until the user clicks */ }
      unobserve() { /* noop */ }
      disconnect() { /* noop */ }
      takeRecords(): IntersectionObserverEntry[] { return []; }
    });
    const fullArtifact = {
      version: 1,
      kind: "presentation",
      title: "Lazy Tool Deck",
      data: { title: "Lazy Tool Deck", slides: [{ title: "Lazy Tool Deck" }] },
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => fullArtifact,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const artifactUrl = "/api/sessions/s1/messages/m-tool-deferred/artifact";
    render(<MessageTimeline messages={[truncatedPresentationToolMessage(artifactUrl)]} />);

    expect(screen.getByText(/Artifact preview deferred \(10\.5 MB\)/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load artifact" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(artifactUrl));
    expect(await screen.findByText("1 slide")).toBeInTheDocument();
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
              { title: "Cover", image: { src: "/tmp/brainco_signals.png" } },
            ],
          },
        }],
      },
    };

    // Before the fix this throws synchronously out of compileRevealHtml and
    // blanks the whole React tree. After the fix it renders a localized
    // alert card with the error message (either at the coercion step — the
    // schema validator rejects unsafe asset paths up-front — or at the
    // compile step if it gets that far) and never crashes the tree.
    expect(() => render(<MessageTimeline messages={[unsafeMessage]} />)).not.toThrow();
    expect(screen.getByTestId("artifact-presentation")).toHaveAttribute("role", "alert");
    expect(screen.getByText(/Unsafe presentation asset path|image\.src is unsafe/)).toBeInTheDocument();
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
