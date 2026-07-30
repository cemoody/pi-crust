import { classifyPresentationAssetPath } from "./asset-path-safety.js";

export interface PresentationAsset {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

export type PresentationAssetResolver = (src: string) => PresentationAsset | string | undefined;

export interface PresentationAssetResolutionOptions {
  readonly assetResolver?: PresentationAssetResolver;
}

export function resolvePresentationAssetSrc(src: string, resolver?: PresentationAssetResolver): string {
  const safety = classifyPresentationAssetPath(src);
  if (safety === "absolute-or-scheme" || safety === "path-traversal") {
    throw new Error(`Unsafe presentation asset path: ${src}`);
  }
  if (safety === "data-uri" || safety === "remote-url") return src;
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
