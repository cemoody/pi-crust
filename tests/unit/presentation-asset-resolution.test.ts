import { describe, expect, it } from "vitest";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import { resolvePresentationAssetSrc } from "../../src/presentations/assets.js";

describe("presentation asset resolution", () => {
  it("embeds resolver-provided local image assets as data URIs", () => {
    const html = compileRevealHtml({
      title: "Asset deck",
      logo: { src: "assets/logo.png", alt: "Logo" },
      slides: [{ title: "Plot", image: { src: "assets/plot.svg", alt: "Plot" } }],
    }, {
      assetResolver(src) {
        if (src.endsWith(".png")) return { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) };
        if (src.endsWith(".svg")) return { mimeType: "image/svg+xml", data: new TextEncoder().encode("<svg />") };
        return undefined;
      },
    });

    expect(html).toContain("data:image/png;base64,AQID");
    expect(html).toContain("data:image/svg+xml;base64,PHN2ZyAvPg==");
    expect(html).toContain("class=\"brand-logo\"");
  });

  it("preserves remote URLs and rejects unsafe local paths", () => {
    expect(resolvePresentationAssetSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(resolvePresentationAssetSrc("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
    expect(() => resolvePresentationAssetSrc("../secret.png")).toThrow(/Unsafe presentation asset path/);
    expect(() => resolvePresentationAssetSrc("/etc/passwd")).toThrow(/Unsafe presentation asset path/);
  });
});
