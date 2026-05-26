import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { prepareLocalPresentationAssets } from "../../src/presentations/local-assets.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

/**
 * `prepareLocalPresentationAssets` is the missing piece that turns the
 * "Unsafe presentation asset path" wall (a security-only check) into an
 * affordance: when an LLM passes an absolute path to a real file that
 * sits inside the session's cwd, we copy it into the session's
 * presentations asset directory and rewrite the deck's `image.src` (and
 * `logo.src`) to the bare filename the asset route serves.
 *
 * The function is pure side-effects + return value: it does file I/O,
 * returns the rewritten deck and a list of copies. It never mutates the
 * input deck. Anything it can't safely resolve is left untouched so the
 * downstream validator surfaces the same actionable error as before.
 */
describe("prepareLocalPresentationAssets", () => {
  let tmpRoot: string;
  let cwd: string;
  let targetDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-localassets-"));
    cwd = path.join(tmpRoot, "session-cwd");
    targetDir = path.join(cwd, ".pi", "presentations", "sess-1");
    await fs.mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeAsset(rel: string, body = "PNGBYTES"): Promise<string> {
    const abs = path.join(cwd, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
    return abs;
  }

  it("copies an absolute path that lives under cwd and rewrites src to the basename", async () => {
    const assetAbs = await writeAsset("adhoc/chart.png", "img1");
    const deck: PresentationDeck = {
      title: "T",
      slides: [
        { title: "Cover" },
        { title: "Pic", image: { src: assetAbs, alt: "chart" } },
      ],
    };

    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });

    expect(out.slides[1]!.image?.src).toBe("chart.png");
    expect(out.slides[1]!.image?.alt).toBe("chart"); // unrelated fields preserved
    expect(copied).toEqual([{ from: assetAbs, to: path.join(targetDir, "chart.png") }]);
    await expect(fs.readFile(path.join(targetDir, "chart.png"), "utf8")).resolves.toBe("img1");
  });

  it("does NOT mutate the input deck (returns a new one)", async () => {
    const assetAbs = await writeAsset("adhoc/a.png");
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "Pic", image: { src: assetAbs } }],
    };
    const snapshot = JSON.parse(JSON.stringify(deck));
    await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(deck).toEqual(snapshot);
  });

  it("leaves https://, data:, and bare relative srcs untouched and does no copy", async () => {
    const deck: PresentationDeck = {
      title: "T",
      slides: [
        { title: "a", image: { src: "https://example.com/x.png" } },
        { title: "b", image: { src: "data:image/png;base64,AAA" } },
        { title: "c", image: { src: "chart.png" } },
      ],
    };
    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(out.slides.map((s) => s.image?.src)).toEqual([
      "https://example.com/x.png",
      "data:image/png;base64,AAA",
      "chart.png",
    ]);
    expect(copied).toEqual([]);
  });

  it("REJECTS absolute paths outside cwd (does not copy, leaves src untouched)", async () => {
    const outsideAbs = path.join(tmpRoot, "outside.png");
    await fs.writeFile(outsideAbs, "evil");
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "Pic", image: { src: outsideAbs } }],
    };
    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(out.slides[0]!.image?.src).toBe(outsideAbs); // unchanged, validator will reject
    expect(copied).toEqual([]);
  });

  it("REJECTS paths containing literal '..' even when they would resolve inside cwd", async () => {
    // Construct the string by concatenation so we keep the literal '..'
    // segments (path.join would normalize them away). A persisted deck
    // with '..' in src would resolve differently in another environment,
    // which is exactly what we want to refuse.
    const sneaky = `${cwd}/adhoc/../x.png`;
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "Pic", image: { src: sneaky } }],
    };
    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(out.slides[0]!.image?.src).toBe(sneaky); // unchanged
    expect(copied).toEqual([]);
  });

  it("REJECTS symlinks under cwd that resolve outside cwd", async () => {
    const outsideAbs = path.join(tmpRoot, "outside-secret.png");
    await fs.writeFile(outsideAbs, "secret outside bytes");
    const linkAbs = path.join(cwd, "linked-secret.png");
    await fs.symlink(outsideAbs, linkAbs);
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "Pic", image: { src: linkAbs } }],
    };

    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });

    expect(out.slides[0]!.image?.src).toBe(linkAbs);
    expect(copied).toEqual([]);
    await expect(fs.stat(path.join(targetDir, "linked-secret.png"))).rejects.toThrow();
  });

  it("leaves the src untouched when the file does not exist (validator will flag it)", async () => {
    const ghost = path.join(cwd, "missing.png");
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "Pic", image: { src: ghost } }],
    };
    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(out.slides[0]!.image?.src).toBe(ghost);
    expect(copied).toEqual([]);
  });

  it("applies to logo.src too", async () => {
    const assetAbs = await writeAsset("brand/logo.png", "logobytes");
    const deck: PresentationDeck = {
      title: "T",
      logo: { src: assetAbs, alt: "brand" },
      slides: [{ title: "x" }],
    };
    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(out.logo?.src).toBe("logo.png");
    expect(copied).toHaveLength(1);
  });

  it("disambiguates colliding basenames by prefixing a short hash", async () => {
    const a = await writeAsset("dir-a/chart.png", "AAA");
    const b = await writeAsset("dir-b/chart.png", "BBB");
    const deck: PresentationDeck = {
      title: "T",
      slides: [
        { title: "a", image: { src: a } },
        { title: "b", image: { src: b } },
      ],
    };
    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    const srcs = out.slides.map((s) => s.image?.src ?? "");
    expect(srcs[0]!).toMatch(/^(chart\.png|[a-f0-9]{8}-chart\.png)$/);
    expect(srcs[1]!).toMatch(/^[a-f0-9]{8}-chart\.png$/);
    expect(srcs[0]).not.toBe(srcs[1]);
    expect(copied).toHaveLength(2);
    // Each rewritten src must have a corresponding file on disk with the
    // right bytes (we don't care which got the bare name vs. the hashed one).
    const dirContents = await fs.readdir(targetDir);
    expect(dirContents.length).toBe(2);
  });

  it("dedupes identical files by content hash: copies once, two slides share the same src", async () => {
    const a = await writeAsset("u/chart.png", "SAMEBYTES");
    const b = await writeAsset("v/chart.png", "SAMEBYTES");
    const deck: PresentationDeck = {
      title: "T",
      slides: [
        { title: "a", image: { src: a } },
        { title: "b", image: { src: b } },
      ],
    };
    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(out.slides[0]!.image?.src).toBe(out.slides[1]!.image?.src);
    expect(copied).toHaveLength(1);
  });

  it("creates the target dir if it doesn't exist yet", async () => {
    const a = await writeAsset("x.png", "X");
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "a", image: { src: a } }],
    };
    // targetDir does not exist yet
    await expect(fs.stat(targetDir)).rejects.toThrow();
    await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    await expect(fs.stat(targetDir)).resolves.toBeTruthy();
  });

  it("is a no-op when there are no slides or no images", async () => {
    const deck: PresentationDeck = { title: "T", slides: [{ title: "x" }] };
    const { deck: out, copied } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(out).toBe(deck); // identity when nothing to do — cheap fast path
    expect(copied).toEqual([]);
  });

  it("treats a file:// URI that points inside cwd the same as an absolute path", async () => {
    const a = await writeAsset("file-scheme.png", "FFF");
    const deck: PresentationDeck = {
      title: "T",
      slides: [{ title: "a", image: { src: `file://${a}` } }],
    };
    const { deck: out } = await prepareLocalPresentationAssets(deck, { cwd, targetDir });
    expect(out.slides[0]!.image?.src).toBe("file-scheme.png");
  });
});
