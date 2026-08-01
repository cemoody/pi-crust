import { describe, expect, it, vi } from "vitest";
import { compileRevealHtmlAsync } from "../../src/presentations/compiler/index.js";
import { compileStandalonePresentationHtml } from "../../src/presentations/standalone.js";
import { compileRevealHtml } from "../../src/presentations/reveal.js";

describe("presentation compiler boundary", () => {
  it("serves template-pack layouts and standalone asset compilation through the public compiler API", async () => {
    const resolveLayout = vi.fn(async (packId: string, layout: string, slots: Record<string, string | number | null | undefined>) => {
      expect(packId).toBe("brand");
      expect(layout).toBe("cover");
      expect(slots).toEqual({ page: 2, heading: "Architecture" });
      return `<article class="brand-cover">${slots.heading}</article>`;
    });
    const deck = {
      title: "Boundary contract",
      templatePack: "brand",
      logo: { src: "brand.png", alt: "Brand" },
      slides: [
        { template: "title", title: "Boundary contract" },
        { layout: "cover", slots: { heading: "Architecture" } },
      ],
    } as const;

    const resolvedHtml = await compileRevealHtmlAsync(deck, { templatePackResolver: resolveLayout });
    expect(resolveLayout).toHaveBeenCalledTimes(1);
    expect(resolvedHtml).toContain('<article class="brand-cover">Architecture</article>');

    const fetchAsset = vi.fn(async (src: string) => {
      expect(src).toBe("brand.png");
      return { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
    });
    const standaloneHtml = await compileStandalonePresentationHtml(deck, {
      fetchAsset,
      templatePackResolver: resolveLayout,
    });

    expect(fetchAsset).toHaveBeenCalledTimes(1);
    expect(resolveLayout).toHaveBeenCalledTimes(2);
    expect(standaloneHtml).toContain('src="data:image/png;base64,AQID"');
    expect(standaloneHtml).toContain('<article class="brand-cover">Architecture</article>');
  });

  it("keeps the legacy reveal entry point behavior-compatible", () => {
    const deck = { title: "Compatibility", slides: [{ title: "Existing callers" }] } as const;
    expect(compileRevealHtml(deck)).toBeDefined();
    expect(compileRevealHtml(deck)).toContain("Existing callers");
  });
});
