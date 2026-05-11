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
  TextArtifactRepresentation,
} from "../../shared/artifact.js";
import { pickRepresentation } from "../../shared/artifact.js";
import { HtmlArtifactFrame } from "./HtmlArtifactFrame.js";
import "./artifact-view.css";

export interface ArtifactViewProps {
  readonly artifact: ArtifactMessageDetails;
  readonly apiBaseUrl?: string | undefined;
}

const SUPPORTED_MIMES: readonly string[] = [
  // Phase C will add "application/vnd.vega-lite.v5+json", "application/vnd.plotly.v1+json"
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
      {artifact.caption ? <figcaption className="artifact-caption">{artifact.caption}</figcaption> : null}
      <ArtifactRepresentationView
        artifactGroupId={artifact.artifactGroupId}
        representation={pick}
        apiBaseUrl={apiBaseUrl}
        fallbackArtifacts={artifact.artifacts}
      />
    </figure>
  );
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
