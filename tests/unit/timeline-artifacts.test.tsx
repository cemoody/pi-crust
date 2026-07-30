// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactPreview,
  ArtifactView,
  artifactBasename,
  type TimelineArtifact,
  type TimelineArtifactDetails,
} from "../../src/web/components/timeline-artifacts.js";

afterEach(() => vi.restoreAllMocks());

describe("timeline artifact rendering", () => {
  it("derives download filenames from paths without query strings", () => {
    expect(artifactBasename("/tmp/reports/weekly.md?version=2#summary")).toBe("weekly.md");
    expect(artifactBasename("C:\\reports\\chart.png")).toBe("chart.png");
    expect(artifactBasename(undefined)).toBeUndefined();
  });

  it("renders a file-backed HTML artifact in a sandboxed iframe", () => {
    const artifact: TimelineArtifact = {
      kind: "html",
      title: "Status",
      path: "/tmp/status.html",
      url: "/api/artifact-file?path=%2Ftmp%2Fstatus.html",
    };
    const { container } = render(<ArtifactPreview artifact={artifact} />);

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(iframe.getAttribute("src")).toContain("/api/artifact-file?path=");
    expect(screen.getByRole("link", { name: "Download artifact" })).toHaveAttribute("download", "status.html");
  });

  it("uses the first supported artifact representation before plain-text fallback", () => {
    const artifact: TimelineArtifactDetails = {
      artifactGroupId: "artifact-1",
      artifacts: [
        { mime: "application/unknown", text: "not rendered" },
        { mime: "text/markdown", text: "# Rendered heading" },
        { mime: "text/plain", text: "fallback text" },
      ],
    };
    render(<ArtifactView artifact={artifact} fallbackText="message fallback" enabledArtifactMimes={undefined} />);

    expect(screen.getByRole("heading", { name: "Rendered heading" })).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-fallback")).not.toBeInTheDocument();
  });
});
