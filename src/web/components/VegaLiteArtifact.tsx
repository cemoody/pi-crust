/**
 * Lazy-loaded Vega-Lite chart renderer.
 *
 * `react-vega` (+ its `vega` / `vega-lite` deps) is multi-hundred-KB gzipped,
 * so we never pull it into the initial bundle. The first artifact that needs
 * it triggers a dynamic import; subsequent charts in the same session reuse
 * the cached module.
 */

import { Suspense, lazy, useMemo } from "react";

import type { VegaLiteArtifactRepresentation } from "../../shared/artifact.js";
import "./chart-artifact.css";

// `react-vega` exports `VegaEmbed`, which auto-detects Vega-Lite vs Vega specs.
const VegaLite = lazy(async () => {
  const mod = await import("react-vega");
  return { default: mod.VegaEmbed };
});

export interface VegaLiteArtifactProps {
  readonly representation: VegaLiteArtifactRepresentation;
}

export function VegaLiteArtifact({ representation }: VegaLiteArtifactProps) {
  const spec = useMemo(() => normalizeSpec(representation.spec), [representation.spec]);
  if (!spec) {
    return <div className="chart-artifact-error">Vega-Lite spec is not an object.</div>;
  }
  return (
    <div className="chart-artifact vega-lite-artifact">
      <Suspense fallback={<ChartLoadingSkeleton kind="Vega-Lite" />}>
        <VegaLite spec={spec as never} options={{ actions: false, renderer: "canvas" }} />
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

function normalizeSpec(spec: unknown): Record<string, unknown> | undefined {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return undefined;
  return spec as Record<string, unknown>;
}
