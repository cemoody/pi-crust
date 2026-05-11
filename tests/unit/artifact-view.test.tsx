// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArtifactView } from "../../src/web/components/ArtifactView.js";
import { ARTIFACT_SCHEMA_VERSION, type ArtifactMessageDetails } from "../../src/shared/artifact.js";

describe("<ArtifactView />", () => {
  it("renders an image representation as <img>", () => {
    const artifact: ArtifactMessageDetails = {
      version: ARTIFACT_SCHEMA_VERSION,
      artifactGroupId: "g1",
      caption: "Revenue by quarter",
      artifacts: [
        { mime: "image/png", src: { kind: "url", url: "/api/sessions/s/artifacts/g1.png" }, alt: "chart" },
        { mime: "text/plain", text: "fallback" },
      ],
    };
    render(<ArtifactView artifact={artifact} apiBaseUrl="http://localhost:8787" />);
    const img = screen.getByRole("img", { name: /chart/ }) as HTMLImageElement;
    expect(img.src).toBe("http://localhost:8787/api/sessions/s/artifacts/g1.png");
    expect(screen.getByText("Revenue by quarter")).toBeTruthy();
  });

  it("falls back to text/plain when no supported renderer matches", () => {
    const artifact: ArtifactMessageDetails = {
      version: ARTIFACT_SCHEMA_VERSION,
      artifactGroupId: "g2",
      artifacts: [
        // Unknown MIME, plus text fallback
        // @ts-expect-error - intentionally unknown
        { mime: "application/x-unknown", spec: {} },
        { mime: "text/plain", text: "summary text" },
      ],
    };
    render(<ArtifactView artifact={artifact} />);
    expect(screen.getByText("summary text")).toBeTruthy();
  });
});
