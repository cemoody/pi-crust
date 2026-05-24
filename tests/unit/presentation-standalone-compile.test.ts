/**
 * TDD red-phase tests for the "download a fully self-contained, CDN-shippable
 * HTML deck" feature.
 *
 * These tests target an API that does not exist yet:
 *
 *   compileStandalonePresentationHtml(deck, {
 *     fetchAsset?: (src: string) => Promise<{ data: Uint8Array; mimeType: string }>,
 *     inlineRemoteAssets?: boolean,
 *   }): Promise<string>
 *
 * Once implemented, the output must be safe to upload to R2 / S3 / any
 * static CDN and load with zero network requests beyond `file://`/`data:`.
 */
import { describe, expect, it, vi } from "vitest";
// NOTE: module + export do not exist yet. Import is expected to fail until
// `src/presentations/standalone.ts` is added in the implementation phase.
import { compileStandalonePresentationHtml } from "../../src/presentations/standalone.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG_BYTES = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
const REMOTE_BYTES = new Uint8Array([9, 9, 9, 9]);

function fetchAssetStub(map: Record<string, { data: Uint8Array; mimeType: string }>) {
  const fn = vi.fn(async (src: string) => {
    const hit = map[src];
    if (!hit) throw new Error(`unexpected asset fetch: ${src}`);
    return hit;
  });
  return fn;
}

const imageDeck = {
  title: "Image Deck",
  logo: { src: "assets/logo.png", alt: "Logo" },
  slides: [
    { template: "title", title: "Image Deck", subtitle: "Cover" },
    { template: "title-bullets", title: "Diagram", image: { src: "assets/plot.svg", alt: "Plot" }, bullets: ["Alpha", "Beta"] },
  ],
} as const;

describe("compileStandalonePresentationHtml — CDN-shippable single-file output", () => {
  it("inlines relative-path image and logo assets as data: URIs", async () => {
    const fetchAsset = fetchAssetStub({
      "assets/logo.png": { data: PNG_BYTES, mimeType: "image/png" },
      "assets/plot.svg": { data: SVG_BYTES, mimeType: "image/svg+xml" },
    });

    const html = await compileStandalonePresentationHtml(imageDeck, { fetchAsset });

    expect(fetchAsset).toHaveBeenCalledWith("assets/logo.png");
    expect(fetchAsset).toHaveBeenCalledWith("assets/plot.svg");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("data:image/svg+xml;base64,");
    // Original relative paths must not appear as src/href values anymore.
    expect(html).not.toMatch(/src=["']assets\//);
    expect(html).not.toMatch(/href=["']assets\//);
  });

  it("leaves remote https:// assets untouched by default", async () => {
    const deck = { ...imageDeck, logo: { src: "https://cdn.example.com/logo.png", alt: "Logo" } };
    const fetchAsset = fetchAssetStub({
      "assets/plot.svg": { data: SVG_BYTES, mimeType: "image/svg+xml" },
    });

    const html = await compileStandalonePresentationHtml(deck, { fetchAsset });

    expect(html).toContain("https://cdn.example.com/logo.png");
    // fetchAsset should not have been called for the remote URL.
    expect(fetchAsset).not.toHaveBeenCalledWith("https://cdn.example.com/logo.png");
  });

  it("inlines remote https:// assets when inlineRemoteAssets is true", async () => {
    const deck = { ...imageDeck, logo: { src: "https://cdn.example.com/logo.png", alt: "Logo" } };
    const fetchAsset = fetchAssetStub({
      "https://cdn.example.com/logo.png": { data: REMOTE_BYTES, mimeType: "image/png" },
      "assets/plot.svg": { data: SVG_BYTES, mimeType: "image/svg+xml" },
    });

    const html = await compileStandalonePresentationHtml(deck, { fetchAsset, inlineRemoteAssets: true });

    expect(html).not.toContain("https://cdn.example.com/logo.png");
    // CQQJCQk= is base64 for [9,9,9,9] preceded by the PNG header bytes,
    // so just assert the data URI form is present for the remote bytes.
    expect(html).toContain("data:image/png;base64,");
    expect(fetchAsset).toHaveBeenCalledWith("https://cdn.example.com/logo.png");
  });

  it("contains no external src/href references after compilation", async () => {
    const fetchAsset = fetchAssetStub({
      "assets/logo.png": { data: PNG_BYTES, mimeType: "image/png" },
      "assets/plot.svg": { data: SVG_BYTES, mimeType: "image/svg+xml" },
    });

    const html = await compileStandalonePresentationHtml(imageDeck, { fetchAsset });

    // No external stylesheet/script tags.
    expect(html).not.toMatch(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=/i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
    // Every src=/href= value must be data:, #, or an empty/in-page anchor.
    const offenders: string[] = [];
    for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      const value = match[1];
      if (!value) continue;
      if (value.startsWith("data:")) continue;
      if (value.startsWith("#")) continue;
      offenders.push(value);
    }
    expect(offenders).toEqual([]);
  });

  it("rejects when fetchAsset fails for a referenced asset", async () => {
    const fetchAsset = vi.fn(async (_src: string) => { throw new Error("nope"); });
    await expect(compileStandalonePresentationHtml(imageDeck, { fetchAsset })).rejects.toThrow(/nope|assets\/logo\.png/);
  });

  it("does not call fetchAsset for already-data:-URI'd assets", async () => {
    const deck = {
      title: "Inline Deck",
      logo: { src: "data:image/png;base64,AAA=", alt: "Logo" },
      slides: [{ template: "title", title: "Inline Deck" }],
    };
    const fetchAsset = vi.fn(async () => ({ data: PNG_BYTES, mimeType: "image/png" }));

    const html = await compileStandalonePresentationHtml(deck, { fetchAsset });

    expect(fetchAsset).not.toHaveBeenCalled();
    expect(html).toContain("data:image/png;base64,AAA=");
  });
});
