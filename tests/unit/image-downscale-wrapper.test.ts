import { describe, expect, it, vi } from "vitest";
import { downscaleImageIfNeeded, MAX_IMAGE_DIMENSION } from "../../src/web/utils/image-downscale.js";

// downscaleImageIfNeeded is the composer-facing wrapper: given a base64 image
// it inspects dimensions and, if either side exceeds MAX_IMAGE_DIMENSION,
// re-encodes the image at the picked smaller size. We inject decoder/encoder
// so this can run in node without canvas.

describe("downscaleImageIfNeeded", () => {
  it("passes through small images without invoking the encoder", async () => {
    const decoder = vi.fn(async () => ({ width: 800, height: 600 }));
    const encoder = vi.fn(async () => ({ data: "ENCODED", mimeType: "image/png" }));

    const result = await downscaleImageIfNeeded(
      { data: "ORIGINAL", mimeType: "image/png" },
      { decoder, encoder },
    );

    expect(decoder).toHaveBeenCalledTimes(1);
    expect(encoder).not.toHaveBeenCalled();
    expect(result).toEqual({ data: "ORIGINAL", mimeType: "image/png", downscaled: false });
  });

  it("re-encodes oversized images at the picked dimensions", async () => {
    const decoder = vi.fn(async () => ({ width: 4000, height: 3000 }));
    const encoder = vi.fn(async () => ({ data: "SMALL", mimeType: "image/png" }));

    const result = await downscaleImageIfNeeded(
      { data: "BIG", mimeType: "image/png" },
      { decoder, encoder, maxDim: 2000 },
    );

    expect(encoder).toHaveBeenCalledTimes(1);
    expect(encoder).toHaveBeenCalledWith("BIG", "image/png", { width: 2000, height: 1500 });
    expect(result).toEqual({ data: "SMALL", mimeType: "image/png", downscaled: true });
  });

  it("uses the configured default max when not specified", async () => {
    // Pick a size just above the default cap so the encoder must run.
    const oversized = MAX_IMAGE_DIMENSION + 100;
    const decoder = vi.fn(async () => ({ width: oversized, height: oversized }));
    const encoder = vi.fn(async () => ({ data: "ENC", mimeType: "image/jpeg" }));

    await downscaleImageIfNeeded(
      { data: "RAW", mimeType: "image/jpeg" },
      { decoder, encoder },
    );

    expect(encoder).toHaveBeenCalledTimes(1);
    expect(encoder).toHaveBeenCalledWith("RAW", "image/jpeg", { width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION });
  });

  it("falls back to the original image when the decoder throws", async () => {
    const decoder = vi.fn(async () => { throw new Error("decode failed"); });
    const encoder = vi.fn();

    const result = await downscaleImageIfNeeded(
      { data: "RAW", mimeType: "image/png" },
      { decoder, encoder },
    );

    expect(result).toEqual({ data: "RAW", mimeType: "image/png", downscaled: false });
    expect(encoder).not.toHaveBeenCalled();
  });
});
