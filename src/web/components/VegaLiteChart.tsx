import { useEffect, useRef, useState } from "react";

/**
 * Renders a Vega-Lite spec into a chart. Imports vega + vega-lite + vega-embed
 * dynamically at first use; the import is also gated behind React.lazy at the
 * call site so the libraries are never fetched until a chart appears.
 *
 * We intentionally avoid `react-vega` so we don't pull in an extra wrapper and
 * can keep the runtime surface tiny. The renderer is fully isolated and never
 * touches the host page's DOM outside its own container.
 */
export default function VegaLiteChart({ spec }: { readonly spec: unknown }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let view: { finalize?: () => void } | undefined;
    (async () => {
      try {
        const { default: embed } = await import("vega-embed");
        if (cancelled || !ref.current) return;
        const result = await embed(ref.current, spec as any, {
          actions: false,
          renderer: "svg",
        });
        if (cancelled) {
          result.view?.finalize?.();
          return;
        }
        view = result.view as unknown as { finalize?: () => void };
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      try {
        view?.finalize?.();
      } catch {
        // ignore
      }
    };
  }, [spec]);

  if (error) {
    return <div className="artifact-error" role="alert">Vega-Lite render failed: {error}</div>;
  }
  return <div className="vega-lite-chart" ref={ref} />;
}
