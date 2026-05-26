/**
 * Rewrite bare/relative `image.src` and `logo.src` (and any `<img src>`
 * embedded in passthrough `slide.html`) to absolute API URLs pointing at
 * the per-session presentations route:
 *
 *   GET /api/sessions/:sessionId/presentations/:file
 *
 * Why this exists:
 *
 * Pi-crust renders the preview and the full-screen modal inside an
 * `<iframe sandbox="allow-scripts" srcDoc={…}>`. A srcDoc iframe lives at
 * the synthetic `about:srcdoc` URL, which has no usable base — so a bare
 * `<img src="chart.png">` has nothing to resolve against and shows up as
 * a broken-image icon, even when the asset was correctly auto-copied
 * (see #168) into `<session.cwd>/.pi/presentations/<sessionId>/`.
 *
 * The download / standalone-compile path doesn't need this: that path
 * already inlines every asset as a `data:` URI via `fetchAsset`.
 *
 * What we leave alone:
 * - `data:` and `https?://` URLs.
 * - Already-absolute API URLs (idempotent).
 * - Strings that look like absolute filesystem paths or have URL
 *   schemes other than http(s) — those would be rejected by the
 *   validator (#166) anyway, so leaving them lets the existing error
 *   path surface them.
 */
import type { PresentationDeck, PresentationImage, PresentationSlide } from "./schema.js";

export interface AbsoluteAssetUrlOptions {
  readonly apiBase: string;
  readonly sessionId: string;
}

const ABSOLUTE_OR_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

/** Returns the same deck reference (===) when nothing needs rewriting. */
export function withAbsolutePresentationAssetUrls(
  deck: PresentationDeck,
  options: AbsoluteAssetUrlOptions,
): PresentationDeck {
  const rewrite = (src: string): string => rewriteSrc(src, options);

  let changed = false;
  const nextSlides: PresentationSlide[] = deck.slides.map((slide) => {
    let nextSlide: PresentationSlide = slide;
    const nextImage = rewriteImage(slide.image, rewrite);
    if (nextImage !== slide.image) {
      const { image: _omit, ...rest } = nextSlide;
      void _omit;
      nextSlide = nextImage ? { ...rest, image: nextImage } : { ...rest };
      changed = true;
    }
    if (typeof nextSlide.html === "string" && nextSlide.html.length > 0) {
      const nextHtml = rewriteImgTagsInHtml(nextSlide.html, rewrite);
      if (nextHtml !== nextSlide.html) {
        nextSlide = { ...nextSlide, html: nextHtml };
        changed = true;
      }
    }
    return nextSlide;
  });
  const nextLogo = rewriteImage(deck.logo, rewrite);
  if (nextLogo !== deck.logo) changed = true;

  if (!changed) return deck;
  const { logo: _omitLogo, ...deckRest } = deck;
  void _omitLogo;
  return nextLogo
    ? { ...deckRest, slides: nextSlides, logo: nextLogo }
    : { ...deckRest, slides: nextSlides };
}

function rewriteImage(
  image: PresentationImage | undefined,
  rewrite: (src: string) => string,
): PresentationImage | undefined {
  if (!image || typeof image.src !== "string") return image;
  const next = rewrite(image.src);
  if (next === image.src) return image;
  return { ...image, src: next };
}

function rewriteSrc(src: string, { apiBase, sessionId }: AbsoluteAssetUrlOptions): string {
  if (!src) return src;
  if (src.startsWith("data:")) return src;
  if (/^https?:\/\//i.test(src)) return src;
  // Absolute filesystem paths and other URL schemes (file://, etc.) are
  // not legal asset srcs in a persisted deck — the validator catches them
  // (#166). Leave them alone so the validator's error wins.
  if (ABSOLUTE_OR_SCHEME.test(src)) return src;
  // Bare relative filenames map to the per-session asset route. URI-encode
  // each path segment so spaces, parentheses, etc. survive the round trip.
  const safe = src.split("/").map(encodeURIComponent).join("/");
  return `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/presentations/${safe}`;
}

/**
 * Rewrite `<img src="bare.png">` inside passthrough HTML. We deliberately
 * only touch the `src` attribute of `<img>` tags — never `srcset`, never
 * <source>, never CSS url(). Template packs are expected to inline their
 * own assets as data: URIs (BrainCo does this in render.mjs), so this is
 * a belt-and-braces step for packs that leave bare references behind.
 */
function rewriteImgTagsInHtml(html: string, rewrite: (src: string) => string): string {
  return html.replace(/<img\b([^>]*?)\bsrc=(["'])([^"']*)\2([^>]*)>/gi, (match, before, quote, src, after) => {
    const next = rewrite(src);
    if (next === src) return match;
    return `<img${before} src=${quote}${next}${quote}${after}>`;
  });
}
