/**
 * Rich artifact wire types — shared between the pi extension that produces them
 * and the web client that renders them.
 *
 * Artifacts ride inside a pi `CustomMessage`:
 *
 *   { role: "custom", customType: ARTIFACT_CUSTOM_TYPE, content: "<text fallback>",
 *     display: true, details: ArtifactMessageDetails }
 *
 * The wire protocol already passes `WireMessage.content` opaquely, so no
 * protocol-version bump is needed to introduce new representation MIMEs.
 *
 * Phase A scope: `image/*` only. Phase B will add `text/html`. Phase C will add
 * declarative chart MIMEs (Vega-Lite, Plotly).
 */

export const ARTIFACT_CUSTOM_TYPE = "artifact" as const;
export const ARTIFACT_SCHEMA_VERSION = 1 as const;

/** A pi-remote-control artifact custom message. The whole shape under `details`. */
export interface ArtifactMessageDetails {
  readonly version: typeof ARTIFACT_SCHEMA_VERSION;
  readonly artifactGroupId: string;
  readonly artifacts: readonly ArtifactRepresentation[];
  readonly caption?: string;
}

/**
 * One alternate representation of the same logical artifact. Renderers walk
 * the list in order and pick the first MIME they understand; the last entry
 * should always be a `text/plain` fallback so RPC/print/low-bandwidth clients
 * degrade gracefully.
 */
export type ArtifactRepresentation =
  | ImageArtifactRepresentation
  | SvgArtifactRepresentation
  | HtmlArtifactRepresentation
  | VegaLiteArtifactRepresentation
  | PlotlyArtifactRepresentation
  | TextArtifactRepresentation;

export interface ImageArtifactRepresentation {
  readonly mime:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "image/gif";
  readonly src: ArtifactSrc;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
  readonly bytes?: number;
}

export interface SvgArtifactRepresentation {
  readonly mime: "image/svg+xml";
  readonly src: ArtifactSrc | { readonly kind: "inline"; readonly svg: string };
  readonly width?: number;
  readonly height?: number;
}

export interface HtmlArtifactRepresentation {
  readonly mime: "text/html";
  /** Inline HTML body. For HTML > 64KB the extension may spill to a URL src instead. */
  readonly html?: string;
  readonly src?: ArtifactSrc;
  /** Initial iframe height in CSS px; iframe will auto-resize via postMessage if available. */
  readonly height?: number;
}

export interface VegaLiteArtifactRepresentation {
  readonly mime: "application/vnd.vega-lite.v5+json";
  readonly spec: unknown;
}

export interface PlotlyArtifactRepresentation {
  readonly mime: "application/vnd.plotly.v1+json";
  readonly figure: unknown;
}

export interface TextArtifactRepresentation {
  readonly mime: "text/plain";
  readonly text: string;
}

/** How to fetch artifact bytes. URL is preferred; data URLs only for tiny payloads. */
export type ArtifactSrc =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "dataUrl"; readonly dataUrl: string };

/** Type guard for custom messages carrying artifact details. */
export function isArtifactMessage(
  message: { readonly role?: string; readonly customType?: string; readonly details?: unknown },
): boolean {
  return (
    message.role === "custom" &&
    message.customType === ARTIFACT_CUSTOM_TYPE &&
    isArtifactMessageDetails(message.details)
  );
}

export function isArtifactMessageDetails(value: unknown): value is ArtifactMessageDetails {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === ARTIFACT_SCHEMA_VERSION &&
    typeof v.artifactGroupId === "string" &&
    Array.isArray(v.artifacts) &&
    v.artifacts.every(isArtifactRepresentation)
  );
}

export function isArtifactRepresentation(value: unknown): value is ArtifactRepresentation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.mime === "string";
}

/** Pick the best representation a renderer can handle, given an ordered list of supported MIMEs. */
export function pickRepresentation(
  artifacts: readonly ArtifactRepresentation[],
  supportedMimes: readonly string[],
): ArtifactRepresentation | undefined {
  for (const mime of supportedMimes) {
    const found = artifacts.find((a) => a.mime === mime);
    if (found) return found;
  }
  return undefined;
}

/** MIME → file extension for the artifact store and HTTP route. */
export const ARTIFACT_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "text/html": "html",
  "text/plain": "txt",
  "application/vnd.vega-lite.v5+json": "vl.json",
  "application/vnd.plotly.v1+json": "plotly.json",
};

export function extensionForMime(mime: string): string {
  return ARTIFACT_MIME_EXTENSIONS[mime] ?? "bin";
}
