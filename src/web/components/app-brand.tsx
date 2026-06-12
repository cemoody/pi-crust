/**
 * App-branding cluster: header link, optional logo image, and the favicon
 * data-URL builder. Extracted from SessionDashboard.tsx so the dashboard
 * file can stay focused on session/state orchestration.
 */
import type { JSX, MouseEvent } from "react";

export function AppBrand({
  appName,
  appIcon,
  onNavigateRoot,
}: {
  readonly appName: string;
  readonly appIcon?: string;
  readonly onNavigateRoot?: () => void;
}): JSX.Element {
  return (
    <a
      className="app-brand"
      href="/"
      aria-label={appName}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onNavigateRoot?.();
      }}
    >
      {appIcon ? <BrandIcon value={appIcon} /> : null}
      <h1>{appName}</h1>
    </a>
  );
}

/**
 * A plain left-click (no modifier keys, primary mouse button) is the
 * signal that we should handle the navigation in-app. Modifier-clicks
 * (cmd/ctrl/shift/alt) and middle-clicks should fall through to the
 * browser so the user gets a real "open in new tab" affordance from
 * any sidebar item.
 */
export function isPlainLeftClick(event: MouseEvent): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

function BrandIcon({ value }: { readonly value: string }): JSX.Element {
  return <img className="app-brand-icon" src={value} alt="" aria-hidden="true" />;
}

export function updateFavicon(appIcon: string | undefined): void {
  if (typeof document === "undefined") return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (!appIcon) {
    delete link.dataset.piRemoteIconSource;
    link.type = "image/svg+xml";
    link.href = "/favicon.svg";
    return;
  }

  // Point the favicon directly at the image URL as an immediate fallback.
  // A <link rel="icon"> pointing straight at a PNG/SVG URL loads fine. We must
  // NOT wrap a remote image inside an SVG data-URI via <image href="…">:
  // browsers sandbox data-URI SVG documents and refuse to fetch external
  // resources from them, which leaves the tab showing a broken-image glyph.
  link.dataset.piRemoteIconSource = appIcon;
  link.removeAttribute("type");
  link.href = appIcon;

  // Refine to a square, letterboxed favicon so non-square logos are not
  // stretched by the tab-strip renderer. We rasterize the bitmap onto a
  // canvas and emit a self-contained PNG data URL (the asset CDN allows CORS).
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    if (link.dataset.piRemoteIconSource !== appIcon) return;
    const dataUrl = rasterizeSquareFavicon(image);
    if (!dataUrl) return;
    if (link.dataset.piRemoteIconSource !== appIcon) return;
    link.type = "image/png";
    link.href = dataUrl;
  };
  image.src = appIcon;
}

/**
 * Draw a loaded image into a 64×64 canvas, contained (letterboxed) so the
 * source aspect ratio is preserved, and return a PNG data URL. Returns
 * undefined when the image has no intrinsic size or the canvas is tainted.
 */
function rasterizeSquareFavicon(image: HTMLImageElement): string | undefined {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (naturalWidth <= 0 || naturalHeight <= 0) return undefined;
  const box = 64;
  const canvas = document.createElement("canvas");
  canvas.width = box;
  canvas.height = box;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const drawn = containedImageBox({ width: naturalWidth, height: naturalHeight }, 56);
  const dx = (box - drawn.width) / 2;
  const dy = (box - drawn.height) / 2;
  ctx.drawImage(image, dx, dy, drawn.width, drawn.height);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    // Canvas tainted (CORS denied) — keep the direct-URL fallback already set.
    return undefined;
  }
}

export function imageFaviconDataUrl(
  imageUrl: string,
  naturalSize?: { readonly width: number; readonly height: number },
): string {
  const href = imageUrl
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const box = 56;
  const size = containedImageBox(naturalSize, box);
  const x = formatSvgNumber((64 - size.width) / 2);
  const y = formatSvgNumber((64 - size.height) / 2);
  const width = formatSvgNumber(size.width);
  const height = formatSvgNumber(size.height);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="transparent"/><image href="${href}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function containedImageBox(
  naturalSize: { readonly width: number; readonly height: number } | undefined,
  max: number,
): { readonly width: number; readonly height: number } {
  if (!naturalSize || naturalSize.width <= 0 || naturalSize.height <= 0) return { width: max, height: max };
  const ratio = naturalSize.width / naturalSize.height;
  return ratio >= 1 ? { width: max, height: max / ratio } : { width: max * ratio, height: max };
}

function formatSvgNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}
