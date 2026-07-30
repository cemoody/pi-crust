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
  return presentationAssetDataUri(resolved);
}

/** Encode a binary presentation asset for use in HTML `src` attributes. */
export function presentationAssetDataUri(asset: PresentationAsset): string {
  const { data, mimeType } = asset;
  if (typeof Buffer !== "undefined") return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return `data:${mimeType};base64,${btoa(binary)}`;
}
