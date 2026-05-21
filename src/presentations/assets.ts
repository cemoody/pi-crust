export interface PresentationAsset {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

export type PresentationAssetResolver = (src: string) => PresentationAsset | string | undefined;

export interface PresentationAssetResolutionOptions {
  readonly assetResolver?: PresentationAssetResolver;
}

const DATA_URI_PATTERN = /^data:/i;
const REMOTE_URL_PATTERN = /^https?:\/\//i;
const ABSOLUTE_OR_SCHEME_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

export function resolvePresentationAssetSrc(src: string, resolver?: PresentationAssetResolver): string {
  if (DATA_URI_PATTERN.test(src) || REMOTE_URL_PATTERN.test(src)) return src;
  if (ABSOLUTE_OR_SCHEME_PATTERN.test(src)) throw new Error(`Unsafe presentation asset path: ${src}`);
  if (src.split(/[\\/]+/).some((part) => part === "..")) throw new Error(`Unsafe presentation asset path: ${src}`);
  const resolved = resolver?.(src);
  if (resolved === undefined) return src;
  if (typeof resolved === "string") return resolved;
  return `data:${resolved.mimeType};base64,${toBase64(resolved.data)}`;
}

function toBase64(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}
