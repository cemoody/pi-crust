/**
 * Compile a presentation deck into a single, fully self-contained HTML
 * document suitable for upload to any static CDN (R2 / S3 / GitHub Pages /
 * Cloudflare Pages / etc.) and offline viewing.
 *
 * Unlike {@link compileRevealHtml}, this function eagerly inlines all
 * referenced image assets as base64 `data:` URIs via a caller-provided
 * {@link FetchAsset} callback. The resulting HTML makes zero network
 * requests on load — that is the operational definition of "CDN-shippable".
 *
 * Remote `https://…` references are preserved by default (callers usually
 * trust the remote CDN). Pass `inlineRemoteAssets: true` to fetch and inline
 * them too for guaranteed offline / link-rot-proof output.
 */
import { compileRevealHtmlAsync, type TemplatePackResolver } from "./reveal.js";
import type { PresentationDeck, PresentationImage, PresentationSlide } from "./schema.js";

export interface FetchedAsset {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

export type FetchAsset = (src: string) => Promise<FetchedAsset>;

export interface CompileStandaloneOptions {
  /**
   * Fetch the bytes for a referenced asset. Required if any deck asset uses
   * a relative path (e.g. `cover.png`). Also called for remote URLs when
   * {@link CompileStandaloneOptions.inlineRemoteAssets} is true.
   */
  readonly fetchAsset?: FetchAsset;
  /** Fetch + inline `https://` assets as data: URIs. Default: false. */
  readonly inlineRemoteAssets?: boolean;
  /** Forwarded to {@link compileRevealHtmlAsync}. */
  readonly templatePackResolver?: TemplatePackResolver;
}

const REMOTE_URL_PATTERN = /^https?:\/\//i;
const DATA_URI_PATTERN = /^data:/i;

export async function compileStandalonePresentationHtml(
  deck: PresentationDeck,
  options: CompileStandaloneOptions = {},
): Promise<string> {
  const inlined = await inlineDeckAssets(deck, options);
  const compileOptions = options.templatePackResolver
    ? { templatePackResolver: options.templatePackResolver }
    : {};
  return compileRevealHtmlAsync(inlined, compileOptions);
}

async function inlineDeckAssets(
  deck: PresentationDeck,
  options: CompileStandaloneOptions,
): Promise<PresentationDeck> {
  const inlineRemote = options.inlineRemoteAssets ?? false;
  const cache = new Map<string, Promise<string>>();

  const resolve = (src: string): Promise<string> => {
    if (DATA_URI_PATTERN.test(src)) return Promise.resolve(src);
    if (REMOTE_URL_PATTERN.test(src) && !inlineRemote) return Promise.resolve(src);
    const cached = cache.get(src);
    if (cached) return cached;
    if (!options.fetchAsset) {
      return Promise.reject(new Error(`compileStandalonePresentationHtml: fetchAsset is required to inline asset: ${src}`));
    }
    const fetcher = options.fetchAsset;
    const promise = (async () => {
      try {
        const asset = await fetcher(src);
        return `data:${asset.mimeType};base64,${toBase64(asset.data)}`;
      } catch (error) {
        // Surface both the original message and the offending src so debug
        // output makes the bad asset obvious.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to inline asset ${src}: ${message}`);
      }
    })();
    cache.set(src, promise);
    return promise;
  };

  const logo = deck.logo ? await rewriteImage(deck.logo, resolve) : undefined;
  const slides = await Promise.all(deck.slides.map((slide) => rewriteSlide(slide, resolve)));
  return { ...deck, ...(logo ? { logo } : {}), slides };
}

async function rewriteSlide(slide: PresentationSlide, resolve: (src: string) => Promise<string>): Promise<PresentationSlide> {
  if (!slide.image) return slide;
  return { ...slide, image: await rewriteImage(slide.image, resolve) };
}

async function rewriteImage(image: PresentationImage, resolve: (src: string) => Promise<string>): Promise<PresentationImage> {
  const src = await resolve(image.src);
  if (src === image.src) return image;
  return { ...image, src };
}

function toBase64(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}
