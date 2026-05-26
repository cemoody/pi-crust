import { describe, expect, it } from "vitest";
import { withAbsolutePresentationAssetUrls } from "../../src/presentations/absolute-asset-urls.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

const OPTS = { apiBase: "", sessionId: "sess-1" };

describe("withAbsolutePresentationAssetUrls", () => {
  it("rewrites bare relative image.src to the per-session asset route", () => {
    const deck: PresentationDeck = {
      title: "T",
      slides: [
        { title: "Cover" },
        { title: "Pic", image: { src: "chart.png", alt: "chart" } },
      ],
    };
    const out = withAbsolutePresentationAssetUrls(deck, OPTS);
    expect(out.slides[1]!.image?.src).toBe(
      "/api/sessions/sess-1/presentations/chart.png",
    );
    expect(out.slides[1]!.image?.alt).toBe("chart"); // unrelated fields preserved
  });

  it("URI-encodes the session id and the filename segments", () => {
    const out = withAbsolutePresentationAssetUrls(
      { title: "T", slides: [{ title: "p", image: { src: "Q4 chart (final).png" } }] },
      { apiBase: "", sessionId: "sess/with/slashes" },
    );
    expect(out.slides[0]!.image?.src).toBe(
      "/api/sessions/sess%2Fwith%2Fslashes/presentations/Q4%20chart%20(final).png",
    );
  });

  it("respects apiBase (no trailing slash issues)", () => {
    const out = withAbsolutePresentationAssetUrls(
      { title: "T", slides: [{ title: "p", image: { src: "x.png" } }] },
      { apiBase: "http://10.0.0.5:8787", sessionId: "s1" },
    );
    expect(out.slides[0]!.image?.src).toBe(
      "http://10.0.0.5:8787/api/sessions/s1/presentations/x.png",
    );
  });

  it("leaves data:, https://, and absolute filesystem paths alone", () => {
    const deck: PresentationDeck = {
      title: "T",
      slides: [
        { title: "a", image: { src: "data:image/png;base64,AAA" } },
        { title: "b", image: { src: "https://example.com/x.png" } },
        { title: "c", image: { src: "/already/absolute.png" } },
        { title: "d", image: { src: "file:///etc/passwd" } },
      ],
    };
    const out = withAbsolutePresentationAssetUrls(deck, OPTS);
    expect(out.slides.map((s) => s.image?.src)).toEqual([
      "data:image/png;base64,AAA",
      "https://example.com/x.png",
      "/already/absolute.png",
      "file:///etc/passwd",
    ]);
  });

  it("returns the original deck reference when nothing changes", () => {
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "a", image: { src: "https://example.com/x.png" } }],
    };
    expect(withAbsolutePresentationAssetUrls(deck, OPTS)).toBe(deck);
  });

  it("rewrites logo.src too", () => {
    const deck: PresentationDeck = {
      title: "T",
      logo: { src: "brand.png", alt: "brand" },
      slides: [{ title: "x" }],
    };
    const out = withAbsolutePresentationAssetUrls(deck, OPTS);
    expect(out.logo?.src).toBe("/api/sessions/sess-1/presentations/brand.png");
  });

  it("rewrites <img src> in passthrough slide.html (BrainCo et al.)", () => {
    // BrainCo inlines its bundled assets as data: URIs in render.mjs; but if a
    // pack leaves a bare-filename <img src> behind, the preview iframe still
    // can't load it. We rewrite as a belt-and-braces step.
    const deck: PresentationDeck = {
      title: "T",
      slides: [
        {
          template: "brainco-bullets-stat",
          html: `<div class="slide"><img class="logo" src="wordmark.png" alt="W"><img src="https://cdn.example.com/keep.png"><img src="data:image/png;base64,B"></div>`,
        },
      ],
    };
    const out = withAbsolutePresentationAssetUrls(deck, OPTS);
    const html = out.slides[0]!.html!;
    expect(html).toContain('src="/api/sessions/sess-1/presentations/wordmark.png"');
    expect(html).toContain('src="https://cdn.example.com/keep.png"');
    expect(html).toContain('src="data:image/png;base64,B"');
  });

  it("does not mutate the input deck", () => {
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "Pic", image: { src: "chart.png" } }],
    };
    const snapshot = JSON.parse(JSON.stringify(deck));
    withAbsolutePresentationAssetUrls(deck, OPTS);
    expect(deck).toEqual(snapshot);
  });
});
