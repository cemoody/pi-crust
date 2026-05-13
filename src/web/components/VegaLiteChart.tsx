import { useEffect, useRef, useState } from "react";

/**
 * Renders a Vega-Lite spec into a chart. Imports vega + vega-lite + vega-embed
 * dynamically at first use; the import is also gated behind React.lazy at the
 * call site so the libraries are never fetched until a chart appears.
 *
 * We intentionally avoid `react-vega` so we don't pull in an extra wrapper and
 * can keep the runtime surface tiny. The renderer is fully isolated and never
 * touches the host page's DOM outside its own container.
 *
 * Sizing note: specs with `width: "container"` rely on the parent element
 * having a measurable width at embed-time. When the chart is mounted as part
 * of a freshly rendered timeline message the parent can briefly report 0 px,
 * which makes vega freeze the SVG at width="0" until something kicks it. We
 * watch the container with a ResizeObserver and call `view.resize()` whenever
 * the container's width grows, so the chart fills its bubble as soon as the
 * surrounding layout settles.
 */
export default function VegaLiteChart({ spec }: { readonly spec: unknown }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let view: { finalize?: () => void; resize?: () => { runAsync?: () => Promise<void> } | void } | undefined;
    let observer: ResizeObserver | undefined;
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
        view = result.view as unknown as typeof view;

        // Kick a resize after the next frame so an initially 0-width parent
        // doesn't leave the chart frozen at width="0".
        const kick = () => {
          if (cancelled || !view) return;
          try {
            const ret = view.resize?.();
            const maybePromise = (ret as { runAsync?: () => Promise<void> } | undefined)?.runAsync?.();
            if (maybePromise && typeof (maybePromise as Promise<void>).then === "function") {
              void (maybePromise as Promise<void>).catch(() => undefined);
            }
          } catch {
            // ignore
          }
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(kick);
        else kick();

        if (typeof ResizeObserver === "function" && ref.current) {
          observer = new ResizeObserver(() => kick());
          observer.observe(ref.current);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      try {
        observer?.disconnect();
      } catch {
        // ignore
      }
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
  // min-height so the artifact reserves vertical space before vega paints,
  // and width:100% so width:"container" specs have a non-zero parent width
  // to measure on first layout.
  return <div className="vega-lite-chart" ref={ref} style={{ width: "100%", minHeight: 260 }} />;
}
