import { describe, expect, it } from "vitest";
import { pickDownscaledDimensions, MAX_IMAGE_DIMENSION } from "../../src/web/utils/image-downscale.js";

// Anthropic rejects multi-image requests when any single image has a side
// > 2000px. The composer should down-scale to stay below that threshold
// before submitting an attachment. This file tests the pure dimension
// calculator; the canvas-backed wrapper is integration-tested elsewhere.

describe("pickDownscaledDimensions", () => {
  it("exports a sensible default max that matches the Anthropic limit", () => {
    expect(MAX_IMAGE_DIMENSION).toBeLessThanOrEqual(2000);
    expect(MAX_IMAGE_DIMENSION).toBeGreaterThanOrEqual(1024);
  });

  it("returns null when the image is already within bounds", () => {
    expect(pickDownscaledDimensions(800, 600, 2000)).toBeNull();
    expect(pickDownscaledDimensions(2000, 1500, 2000)).toBeNull();
    expect(pickDownscaledDimensions(1, 1, 2000)).toBeNull();
  });

  it("scales landscape images so the longest side equals max", () => {
    expect(pickDownscaledDimensions(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(pickDownscaledDimensions(2500, 1000, 2000)).toEqual({ width: 2000, height: 800 });
  });

  it("scales portrait images so the longest side equals max", () => {
    expect(pickDownscaledDimensions(1500, 4000, 2000)).toEqual({ width: 750, height: 2000 });
    expect(pickDownscaledDimensions(1000, 2500, 2000)).toEqual({ width: 800, height: 2000 });
  });

  it("scales square images symmetrically", () => {
    expect(pickDownscaledDimensions(3000, 3000, 2000)).toEqual({ width: 2000, height: 2000 });
  });

  it("never produces a side smaller than 1px", () => {
    // A 100000x1 image scaled to max=2000 would be 2000x0.02; we must clamp to 1.
    const result = pickDownscaledDimensions(100_000, 1, 2000);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(2000);
    expect(result!.height).toBeGreaterThanOrEqual(1);
  });

  it("returns null for non-finite or non-positive dimensions", () => {
    expect(pickDownscaledDimensions(0, 100, 2000)).toBeNull();
    expect(pickDownscaledDimensions(100, 0, 2000)).toBeNull();
    expect(pickDownscaledDimensions(Number.NaN, 100, 2000)).toBeNull();
    expect(pickDownscaledDimensions(100, Number.POSITIVE_INFINITY, 2000)).toBeNull();
  });
});
