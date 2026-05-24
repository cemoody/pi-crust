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
  link.type = "image/svg+xml";
  if (!appIcon) {
    delete link.dataset.piRemoteIconSource;
    link.href = "/favicon.svg";
    return;
  }

  // Start with a safe square SVG wrapper immediately, then refine it after
  // the browser tells us the image's intrinsic dimensions. Chrome's tab-strip
  // favicon renderer has historically stretched non-square bitmap favicons;
  // using explicit SVG image geometry avoids depending on favicon-specific
  // preserveAspectRatio handling for wide logos.
  link.dataset.piRemoteIconSource = appIcon;
  link.href = imageFaviconDataUrl(appIcon);

  const image = new Image();
  image.onload = () => {
    if (link.dataset.piRemoteIconSource !== appIcon) return;
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    link.href = imageFaviconDataUrl(appIcon, { width: image.naturalWidth, height: image.naturalHeight });
  };
  image.src = appIcon;
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
