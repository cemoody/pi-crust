/**
 * Renders a `text/html` artifact representation inside a sandboxed iframe.
 *
 * Security model:
 *   - sandbox="allow-scripts" only. We intentionally do NOT pass
 *     allow-same-origin (so the snippet sees a null origin and cannot read
 *     parent cookies/localStorage), allow-top-navigation, or allow-forms.
 *   - The HTML template baked by the extension includes a tiny ResizeObserver
 *     script that posts {type:"artifact:resize", artifactGroupId, height} to
 *     window.parent. We accept those messages only when event.source matches
 *     this frame's contentWindow, then clamp the height to a sane range.
 *
 * Supports two source modes:
 *   - Inline HTML (`html` field): rendered via the iframe `srcDoc` attribute.
 *   - URL src (`src.kind === "url"`): rendered via the iframe `src` attribute,
 *     used when the snippet was spilled to a file by the extension.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { HtmlArtifactRepresentation } from "../../shared/artifact.js";
import "./html-artifact-frame.css";

export interface HtmlArtifactFrameProps {
  readonly artifactGroupId: string;
  readonly representation: HtmlArtifactRepresentation;
  readonly apiBaseUrl?: string | undefined;
  /** Maximum auto-resized iframe height in CSS pixels. Defaults to 1600. */
  readonly maxHeight?: number | undefined;
}

const DEFAULT_INITIAL_HEIGHT = 320;
const MIN_HEIGHT = 48;
const DEFAULT_MAX_HEIGHT = 1600;

export function HtmlArtifactFrame({
  artifactGroupId,
  representation,
  apiBaseUrl,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: HtmlArtifactFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initial = representation.height ?? DEFAULT_INITIAL_HEIGHT;
  const [height, setHeight] = useState<number>(initial);
  const [fullscreen, setFullscreen] = useState(false);

  const onResize = useCallback(
    (event: MessageEvent) => {
      const data = event.data;
      if (!isResizeMessage(data)) return;
      if (data.artifactGroupId !== artifactGroupId) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const clamped = Math.max(MIN_HEIGHT, Math.min(maxHeight, Math.round(data.height)));
      setHeight(clamped);
    },
    [artifactGroupId, maxHeight],
  );

  useEffect(() => {
    window.addEventListener("message", onResize);
    return () => window.removeEventListener("message", onResize);
  }, [onResize]);

  const src = representation.src ? resolveSrc(representation.src, apiBaseUrl) : undefined;
  const srcDoc = representation.html;

  return (
    <div className={`html-artifact ${fullscreen ? "fullscreen" : ""}`}>
      <div className="html-artifact-toolbar">
        <button
          type="button"
          className="html-artifact-fullscreen-toggle"
          onClick={() => setFullscreen((v) => !v)}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "Open fullscreen"}
        >
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
      <iframe
        ref={iframeRef}
        className="html-artifact-frame"
        title={`HTML artifact ${artifactGroupId}`}
        sandbox="allow-scripts"
        // referrerPolicy keeps the null-origin frame from leaking referrer headers when it loads sub-resources.
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height: fullscreen ? "calc(100vh - 80px)" : `${height}px` }}
        {...(src ? { src } : {})}
        {...(srcDoc ? { srcDoc } : {})}
      />
    </div>
  );
}

interface ResizeMessage {
  readonly type: "artifact:resize";
  readonly artifactGroupId: string;
  readonly height: number;
}

function isResizeMessage(value: unknown): value is ResizeMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "artifact:resize" &&
    typeof v.artifactGroupId === "string" &&
    typeof v.height === "number" &&
    Number.isFinite(v.height)
  );
}

function resolveSrc(
  src: { readonly kind: "url"; readonly url: string } | { readonly kind: "inline"; readonly svg: string } | { readonly kind: "dataUrl"; readonly dataUrl: string },
  apiBaseUrl: string | undefined,
): string | undefined {
  if (src.kind === "dataUrl") return src.dataUrl;
  if (src.kind === "inline") return undefined; // inline SVG handled separately
  if (!apiBaseUrl) return src.url;
  if (src.url.startsWith("http://") || src.url.startsWith("https://")) return src.url;
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  return `${base}${src.url}`;
}
