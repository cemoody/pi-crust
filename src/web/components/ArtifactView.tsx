/**
 * Renderer for first-class artifact messages emitted by the artifact pi
 * extension via `pi.sendMessage({ customType: "artifact", details: ... })`.
 *
 * Picks the best representation it understands per the supported MIME list and
 * falls through to the `text/plain` representation when nothing else matches.
 *
 * Phase A: image/* only. Later phases will add text/html (sandboxed iframe),
 * Vega-Lite, and Plotly.
 */

import type {
  ArtifactMessageDetails,
  ArtifactRepresentation,
  HtmlArtifactRepresentation,
  ImageArtifactRepresentation,
  PlotlyArtifactRepresentation,
  TextArtifactRepresentation,
  VegaLiteArtifactRepresentation,
} from "../../shared/artifact.js";
import { pickRepresentation } from "../../shared/artifact.js";
import { HtmlArtifactFrame } from "./HtmlArtifactFrame.js";
import { PlotlyArtifact } from "./PlotlyArtifact.js";
import { VegaLiteArtifact } from "./VegaLiteArtifact.js";
import "./artifact-view.css";

export interface ArtifactViewProps {
  readonly artifact: ArtifactMessageDetails;
  readonly apiBaseUrl?: string | undefined;
}

// Order matters: the first MIME the renderer recognizes wins. Charts are
// preferred over HTML/image because they re-theme automatically.
const SUPPORTED_MIMES: readonly string[] = [
  "application/vnd.vega-lite.v5+json",
  "application/vnd.plotly.v1+json",
  "text/html",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
];

export function ArtifactView({ artifact, apiBaseUrl }: ArtifactViewProps) {
  const pick = pickRepresentation(artifact.artifacts, SUPPORTED_MIMES);
  return (
    <figure className="artifact-message" aria-label={artifact.caption ?? "Artifact"}>
      <div className="artifact-header">
        {artifact.caption ? <figcaption className="artifact-caption">{artifact.caption}</figcaption> : <span />}
        <ArtifactActions artifact={artifact} pick={pick} apiBaseUrl={apiBaseUrl} />
      </div>
      <ArtifactRepresentationView
        artifactGroupId={artifact.artifactGroupId}
        representation={pick}
        apiBaseUrl={apiBaseUrl}
        fallbackArtifacts={artifact.artifacts}
      />
    </figure>
  );
}

function ArtifactActions({
  artifact,
  pick,
  apiBaseUrl,
}: {
  readonly artifact: ArtifactMessageDetails;
  readonly pick: ArtifactRepresentation | undefined;
  readonly apiBaseUrl: string | undefined;
}) {
  // Find any url-backed representation so we can offer download.
  const downloadable = artifact.artifacts.find((r) => {
    if (r.mime === "text/plain") return false;
    if ("src" in r && r.src && (r.src as { kind?: string }).kind === "url") return true;
    return false;
  });
  let downloadHref: string | undefined;
  if (downloadable && "src" in downloadable && downloadable.src && (downloadable.src as { kind?: string }).kind === "url") {
    const url = (downloadable.src as { kind: "url"; url: string }).url;
    downloadHref = resolveUrl(url, apiBaseUrl);
  }
  async function copyText() {
    const fallback = artifact.artifacts.find((r): r is TextArtifactRepresentation => r.mime === "text/plain");
    if (!fallback) return;
    try {
      await navigator.clipboard?.writeText(fallback.text);
    } catch {
      // best-effort
    }
  }
  const showCopy = pick?.mime !== "text/plain" && artifact.artifacts.some((r) => r.mime === "text/plain");
  if (!downloadHref && !showCopy) return null;
  return (
    <div className="artifact-actions" role="group" aria-label="Artifact actions">
      {downloadHref ? (
        <a
          className="artifact-action artifact-action-download"
          href={downloadHref}
          download
          aria-label="Download artifact"
          title="Download"
        >
          Download
        </a>
      ) : null}
      {showCopy ? (
        <button
          type="button"
          className="artifact-action artifact-action-copy"
          onClick={() => void copyText()}
          aria-label="Copy fallback text"
          title="Copy fallback text"
        >
          Copy text
        </button>
      ) : null}
    </div>
  );
}

function resolveUrl(url: string, apiBaseUrl: string | undefined): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (!apiBaseUrl) return url;
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  return `${base}${url}`;
}

function ArtifactRepresentationView({
  artifactGroupId,
  representation,
  apiBaseUrl,
  fallbackArtifacts,
}: {
  readonly artifactGroupId: string;
  readonly representation: ArtifactRepresentation | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly fallbackArtifacts: readonly ArtifactRepresentation[];
}) {
  if (!representation) {
    // No renderer matched; show the text/plain fallback if present, otherwise a JSON dump.
    const text = fallbackArtifacts.find((r): r is TextArtifactRepresentation => r.mime === "text/plain");
    if (text) return <pre className="artifact-fallback-text">{text.text}</pre>;
    return <pre className="artifact-fallback-json">{JSON.stringify(fallbackArtifacts, null, 2)}</pre>;
  }
  if (
    representation.mime === "image/png" ||
    representation.mime === "image/jpeg" ||
    representation.mime === "image/webp" ||
    representation.mime === "image/gif"
  ) {
    return <ImageRepresentationView representation={representation} apiBaseUrl={apiBaseUrl} />;
  }
  if (representation.mime === "text/html") {
    return (
      <HtmlArtifactFrame
        artifactGroupId={artifactGroupId}
        representation={representation as HtmlArtifactRepresentation}
        apiBaseUrl={apiBaseUrl}
      />
    );
  }
  if (representation.mime === "application/vnd.vega-lite.v5+json") {
    return <VegaLiteArtifact representation={representation as VegaLiteArtifactRepresentation} />;
  }
  if (representation.mime === "application/vnd.plotly.v1+json") {
    return <PlotlyArtifact representation={representation as PlotlyArtifactRepresentation} />;
  }
  if (representation.mime === "text/plain") {
    return <pre className="artifact-fallback-text">{representation.text}</pre>;
  }
  return <pre className="artifact-fallback-json">{JSON.stringify(representation, null, 2)}</pre>;
}

function ImageRepresentationView({
  representation,
  apiBaseUrl,
}: {
  readonly representation: ImageArtifactRepresentation;
  readonly apiBaseUrl?: string | undefined;
}) {
  const src = resolveSrc(representation.src, apiBaseUrl);
  return (
    <img
      className="artifact-image"
      src={src}
      alt={representation.alt ?? "Artifact image"}
      loading="lazy"
      decoding="async"
      {...(representation.width ? { width: representation.width } : {})}
      {...(representation.height ? { height: representation.height } : {})}
    />
  );
}

function resolveSrc(
  src: { readonly kind: "url"; readonly url: string } | { readonly kind: "dataUrl"; readonly dataUrl: string },
  apiBaseUrl: string | undefined,
): string {
  if (src.kind === "dataUrl") return src.dataUrl;
  if (!apiBaseUrl) return src.url;
  // Allow callers to pass an absolute base (e.g., "http://localhost:8787") to
  // prefix relative artifact URLs that come straight off the extension.
  if (src.url.startsWith("http://") || src.url.startsWith("https://")) return src.url;
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  return `${base}${src.url}`;
}
