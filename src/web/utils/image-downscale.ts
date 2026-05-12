/**
 * Image-downscale helpers used by the prompt composer.
 *
 * Anthropic rejects multi-image requests where any image side exceeds
 * 2000 px (and other providers have similar limits), so we shrink large
 * attachments client-side before submitting them. The pure
 * `pickDownscaledDimensions` function does the maths; the wrapper
 * `downscaleImageIfNeeded` takes a base64 image plus pluggable decoder /
 * encoder dependencies so it can be unit-tested without a DOM canvas.
 */

/**
 * Max allowed dimension on a side. We pick 1568 px — Anthropic's
 * documented "long edge" recommendation, comfortably below the 2000 px
 * limit that triggers the "exceed max allowed size for many-image
 * requests" rejection in the wild.
 */
export const MAX_IMAGE_DIMENSION = 1568;

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Compute target dimensions for an image. Returns `null` when the input
 * is already within `max` on both sides (no downscaling needed) or when
 * the input is non-finite / non-positive.
 */
export function pickDownscaledDimensions(width: number, height: number, max: number): Dimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width <= max && height <= max) return null;
  const scale = max / Math.max(width, height);
  // Clamp to at least 1px to avoid producing a degenerate 0-height image
  // for very tall/wide inputs (e.g. 100000x1).
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { width: w, height: h };
}

export type ImageDecoder = (data: string, mimeType: string) => Promise<Dimensions>;
export type ImageEncoder = (data: string, mimeType: string, target: Dimensions) => Promise<{ data: string; mimeType: string }>;

export interface DownscaleOptions {
  readonly maxDim?: number;
  readonly decoder?: ImageDecoder;
  readonly encoder?: ImageEncoder;
}

export interface DownscaleResult {
  readonly data: string;
  readonly mimeType: string;
  readonly downscaled: boolean;
}

/**
 * Decode → measure → re-encode (when oversized). Returns the original
 * bytes on decode failure rather than blocking the upload.
 */
export async function downscaleImageIfNeeded(
  input: { data: string; mimeType: string },
  options: DownscaleOptions = {},
): Promise<DownscaleResult> {
  const maxDim = options.maxDim ?? MAX_IMAGE_DIMENSION;
  const decoder = options.decoder ?? defaultDecoder;
  const encoder = options.encoder ?? defaultEncoder;

  let dims: Dimensions;
  try {
    dims = await decoder(input.data, input.mimeType);
  } catch {
    return { data: input.data, mimeType: input.mimeType, downscaled: false };
  }

  const target = pickDownscaledDimensions(dims.width, dims.height, maxDim);
  if (!target) return { data: input.data, mimeType: input.mimeType, downscaled: false };

  try {
    const encoded = await encoder(input.data, input.mimeType, target);
    return { data: encoded.data, mimeType: encoded.mimeType, downscaled: true };
  } catch {
    return { data: input.data, mimeType: input.mimeType, downscaled: false };
  }
}

// ---- default browser-backed implementations --------------------------------

let canvasSupportedCache: boolean | undefined;
function canvasSupported(): boolean {
  if (canvasSupportedCache !== undefined) return canvasSupportedCache;
  if (typeof document === "undefined") {
    canvasSupportedCache = false;
    return false;
  }
  try {
    const probe = document.createElement("canvas");
    canvasSupportedCache = typeof probe.getContext === "function" && probe.getContext("2d") !== null;
  } catch {
    canvasSupportedCache = false;
  }
  return canvasSupportedCache;
}

const defaultDecoder: ImageDecoder = (data, mimeType) => new Promise((resolve, reject) => {
  if (typeof Image === "undefined" || !canvasSupported()) {
    reject(new Error("Image decoder unavailable in this environment"));
    return;
  }
  const img = new Image();
  img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
  img.onerror = () => reject(new Error("failed to decode image"));
  img.src = `data:${mimeType};base64,${data}`;
});

const defaultEncoder: ImageEncoder = (data, mimeType, target) => new Promise((resolve, reject) => {
  if (typeof document === "undefined" || typeof Image === "undefined" || !canvasSupported()) {
    reject(new Error("Image encoder unavailable in this environment"));
    return;
  }
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      ctx.drawImage(img, 0, 0, target.width, target.height);
      // Prefer JPEG for photo-like content to shrink payloads; keep PNG for
      // images that began as PNG (likely screenshots with sharp edges).
      const outMime = mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
      const dataUrl = canvas.toDataURL(outMime, 0.92);
      const comma = dataUrl.indexOf(",");
      const out = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
      resolve({ data: out, mimeType: outMime });
    } catch (err) {
      reject(err);
    }
  };
  img.onerror = () => reject(new Error("failed to decode image for re-encode"));
  img.src = `data:${mimeType};base64,${data}`;
});
