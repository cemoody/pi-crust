import { describe, expect, it } from "vitest";
import { classifyPresentationAssetPath } from "../../src/presentations/asset-path-safety.js";
import { resolvePresentationAssetSrc } from "../../src/presentations/assets.js";
import { describeUnsafeAssetPath } from "../../src/presentations/schema.js";

describe("presentation asset path safety", () => {
  it.each([
    ["chart.png", "relative"],
    ["assets/chart.png", "relative"],
    ["data:image/png;base64,abc", "data-uri"],
    ["HTTPS://example.com/chart.png", "remote-url"],
    ["/tmp/chart.png", "absolute-or-scheme"],
    ["file:///tmp/chart.png", "absolute-or-scheme"],
    ["../chart.png", "path-traversal"],
    ["assets\\..\\chart.png", "path-traversal"],
  ] as const)("classifies %s as %s", (src, expected) => {
    expect(classifyPresentationAssetPath(src)).toBe(expected);
  });

  it("keeps schema validation and rendering aligned", () => {
    for (const src of ["chart.png", "https://example.com/chart.png", "data:image/png;base64,abc"]) {
      expect(describeUnsafeAssetPath(src)).toBeUndefined();
      expect(resolvePresentationAssetSrc(src)).toBe(src);
    }

    for (const src of ["/tmp/chart.png", "file:///tmp/chart.png", "../chart.png"]) {
      expect(describeUnsafeAssetPath(src)).toContain("is unsafe");
      expect(() => resolvePresentationAssetSrc(src)).toThrow(`Unsafe presentation asset path: ${src}`);
    }
  });
});
