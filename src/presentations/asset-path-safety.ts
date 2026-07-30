/**
 * Classifies asset sources using the presentation persistence policy.
 *
 * Relative paths, data URIs, and HTTP(S) URLs are safe. All other schemes,
 * filesystem-absolute paths, and parent-directory traversal are rejected.
 */
export type PresentationAssetPathKind =
  | "data-uri"
  | "remote-url"
  | "relative"
  | "absolute-or-scheme"
  | "path-traversal";

const DATA_URI_PATTERN = /^data:/i;
const REMOTE_URL_PATTERN = /^https?:\/\//i;
const ABSOLUTE_OR_SCHEME_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

export function classifyPresentationAssetPath(src: string): PresentationAssetPathKind {
  if (DATA_URI_PATTERN.test(src)) return "data-uri";
  if (REMOTE_URL_PATTERN.test(src)) return "remote-url";
  if (ABSOLUTE_OR_SCHEME_PATTERN.test(src)) return "absolute-or-scheme";
  return src.split(/[\\/]+/).some((part) => part === "..") ? "path-traversal" : "relative";
}
