// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ARTIFACT_SCHEMA_VERSION, type ArtifactMessageDetails } from "../../src/shared/artifact.js";
import { ArtifactView } from "../../src/web/components/ArtifactView.js";
import { PlotlyArtifact } from "../../src/web/components/PlotlyArtifact.js";
import { VegaLiteArtifact } from "../../src/web/components/VegaLiteArtifact.js";

// Stub the heavy chart libs so unit tests don't need their multi-MB runtime
// and DOM canvas. We just assert the wrapper components dispatch correctly
// and pass the spec/figure through unchanged.
vi.mock("react-vega", () => ({
  VegaEmbed: ({ spec }: { spec: unknown }) => (
    <div data-testid="vega-embed-stub">{JSON.stringify(spec)}</div>
  ),
}));

vi.mock("react-plotly.js", () => ({
  default: ({ data }: { data: unknown }) => (
    <div data-testid="plotly-stub">{JSON.stringify(data)}</div>
  ),
}));

describe("declarative chart artifacts", () => {
  it("VegaLiteArtifact renders the VegaEmbed component with the spec", async () => {
    const spec = { mark: "bar", data: { values: [{ a: 1 }, { a: 2 }] } };
    render(
      <VegaLiteArtifact representation={{ mime: "application/vnd.vega-lite.v5+json", spec }} />,
    );
    const node = await screen.findByTestId("vega-embed-stub");
    expect(JSON.parse(node.textContent ?? "{}")).toEqual(spec);
  });

  it("VegaLiteArtifact shows an inline error for non-object specs", () => {
    render(
      <VegaLiteArtifact
        representation={{ mime: "application/vnd.vega-lite.v5+json", spec: "not-an-object" as unknown }}
      />,
    );
    expect(screen.getByText(/spec is not an object/i)).toBeTruthy();
  });

  it("PlotlyArtifact renders the Plot default export with the figure data", async () => {
    const figure = { data: [{ x: [1, 2], y: [3, 4], type: "scatter" }], layout: { title: "demo" } };
    render(
      <PlotlyArtifact representation={{ mime: "application/vnd.plotly.v1+json", figure }} />,
    );
    const node = await screen.findByTestId("plotly-stub");
    expect(JSON.parse(node.textContent ?? "[]")).toEqual(figure.data);
  });

  it("PlotlyArtifact shows an inline error when the figure lacks a data array", () => {
    render(
      <PlotlyArtifact
        representation={{ mime: "application/vnd.plotly.v1+json", figure: { layout: {} } as unknown }}
      />,
    );
    expect(screen.getByText(/data.*array/i)).toBeTruthy();
  });

  it("ArtifactView prefers vega-lite over text/html when both are present", async () => {
    const artifact: ArtifactMessageDetails = {
      version: ARTIFACT_SCHEMA_VERSION,
      artifactGroupId: "g",
      artifacts: [
        { mime: "text/html", html: "<p>html-loses</p>" },
        { mime: "application/vnd.vega-lite.v5+json", spec: { mark: "bar" } },
        { mime: "text/plain", text: "fallback" },
      ],
    };
    render(<ArtifactView artifact={artifact} />);
    expect(await screen.findByTestId("vega-embed-stub")).toBeTruthy();
  });

  it("ArtifactView dispatches plotly representations to PlotlyArtifact", async () => {
    const artifact: ArtifactMessageDetails = {
      version: ARTIFACT_SCHEMA_VERSION,
      artifactGroupId: "g",
      artifacts: [
        { mime: "application/vnd.plotly.v1+json", figure: { data: [{ x: [1] }] } },
        { mime: "text/plain", text: "fallback" },
      ],
    };
    render(<ArtifactView artifact={artifact} />);
    expect(await screen.findByTestId("plotly-stub")).toBeTruthy();
  });
});
