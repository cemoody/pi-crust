/**
 * Lazy-loaded Plotly chart renderer.
 *
 * Plotly's bundle is in the multi-megabyte range, so the dynamic import is
 * mandatory rather than a nice-to-have.
 */

import React, { Suspense, lazy, useMemo } from "react";

import type { PlotlyArtifactRepresentation } from "../../shared/artifact.js";
import "./chart-artifact.css";

// `react-plotly.js` is a CJS module whose default export is the `Plot` component.
// We re-extract it to satisfy React.lazy's `{ default: ComponentType }` shape.
// `react-plotly.js` is a CJS module whose default export is the `Plot` component.
// We re-extract it to satisfy React.lazy's `{ default: ComponentType }` shape.
const Plot = lazy<React.ComponentType<{
  data: ReadonlyArray<Record<string, unknown>>;
  layout?: Record<string, unknown>;
  config?: Record<string, unknown>;
  useResizeHandler?: boolean;
  style?: React.CSSProperties;
}>>(async () => {
  const mod: any = await import("react-plotly.js");
  return { default: mod.default ?? mod };
});

export interface PlotlyArtifactProps {
  readonly representation: PlotlyArtifactRepresentation;
}

export function PlotlyArtifact({ representation }: PlotlyArtifactProps) {
  const figure = useMemo(() => normalizeFigure(representation.figure), [representation.figure]);
  if (!figure) {
    return <div className="chart-artifact-error">Plotly figure is not an object with a `data` array.</div>;
  }
  return (
    <div className="chart-artifact plotly-artifact">
      <Suspense fallback={<ChartLoadingSkeleton kind="Plotly" />}>
        <Plot
          data={figure.data}
          layout={figure.layout ?? {}}
          config={figure.config ?? { displaylogo: false }}
          useResizeHandler
          style={{ width: "100%", height: "100%" }}
        />
      </Suspense>
    </div>
  );
}

function ChartLoadingSkeleton({ kind }: { readonly kind: string }) {
  return (
    <div className="chart-artifact-skeleton" role="status" aria-label={`Loading ${kind} renderer`}>
      <span>Loading {kind}…</span>
    </div>
  );
}

interface NormalizedFigure {
  readonly data: ReadonlyArray<Record<string, unknown>>;
  readonly layout?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
}

function normalizeFigure(value: unknown): NormalizedFigure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.data)) return undefined;
  return {
    data: v.data as ReadonlyArray<Record<string, unknown>>,
    ...(v.layout && typeof v.layout === "object" ? { layout: v.layout as Record<string, unknown> } : {}),
    ...(v.config && typeof v.config === "object" ? { config: v.config as Record<string, unknown> } : {}),
  };
}
