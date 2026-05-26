/**
 * Auto-copy local presentation assets into the session's asset directory.
 *
 * Background: the presentations asset route only serves files from
 * `<session.cwd>/.pi/presentations/<sessionId>/`, and only by a bare
 * filename (see `isSafeFileSegment` in
 * `@cemoody/pi-crust-ext-presentations/server.mjs`). That's a hard
 * security boundary we don't want to relax. But it makes the most
 * natural LLM workflow — "I wrote a chart at /home/.../foo.png; show
 * it" — fail with the "Unsafe presentation asset path" wall.
 *
 * This module bridges the two: when an `image.src` (or `logo.src`) is
 * an absolute path (or `file://` URI) that lexically resolves *inside*
 * cwd and points at a real regular file, we copy it into the target
 * directory and rewrite the deck's src to the bare filename. Anything
 * we can't safely resolve is left untouched so the downstream validator
 * surfaces the same actionable error as before.
 *
 * Determinism / dedupe:
 * - Identical files (same SHA-256) are copied once and share a single src.
 * - Different files with the same basename are disambiguated by an
 *   8-char hash prefix (e.g. `a1b2c3d4-chart.png`). The first file with
 *   a given basename keeps the bare name when possible.
 * - The input deck is never mutated.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import type {
  PresentationDeck,
  PresentationImage,
  PresentationSlide,
} from "./schema.js";

export interface PrepareLocalAssetsOptions {
  /** Session cwd. Only absolute paths lexically inside this are copied. */
  readonly cwd: string;
  /** Destination directory; created on demand. Typically
   *  `<cwd>/.pi/presentations/<sessionId>/`. */
  readonly targetDir: string;
}

export interface PreparedLocalAssetCopy {
  readonly from: string;
  readonly to: string;
}

export interface PrepareLocalAssetsResult {
  readonly deck: PresentationDeck;
  readonly copied: readonly PreparedLocalAssetCopy[];
}

const ABSOLUTE_PATH_PATTERN = /^\//; // Unix absolute; matches what assets.ts rejects.
const FILE_URI_PATTERN = /^file:\/\//i;

/**
 * Resolve a deck's local-file image refs into the target asset directory.
 * See module doc for full semantics. Returns the original deck reference
 * (===) when nothing needs copying.
 */
export async function prepareLocalPresentationAssets(
  deck: PresentationDeck,
  options: PrepareLocalAssetsOptions,
): Promise<PrepareLocalAssetsResult> {
  // Fast path: no images at all → no work, return identity.
  const anyImages =
    (deck.logo && typeof deck.logo.src === "string") ||
    deck.slides.some((slide) => slide.image && typeof slide.image.src === "string");
  if (!anyImages) return { deck, copied: [] };

  // Cache: absolute source path → (rewritten src, copy record)
  // Also dedupes by content hash via a parallel map keyed on hash.
  const byAbsSrc = new Map<string, { src: string; copy?: PreparedLocalAssetCopy }>();
  const byContentHash = new Map<string, string>(); // hash → final basename
  const usedNames = new Set<string>();
  const copied: PreparedLocalAssetCopy[] = [];
  const realCwd = await fs.realpath(options.cwd);
  let targetDirEnsured = false;
  const ensureTargetDir = async () => {
    if (targetDirEnsured) return;
    await fs.mkdir(options.targetDir, { recursive: true });
    targetDirEnsured = true;
  };

  const tryResolve = async (src: string): Promise<string> => {
    const cached = byAbsSrc.get(src);
    if (cached) return cached.src;
    const abs = absolutePathFor(src);
    if (!abs) {
      byAbsSrc.set(src, { src });
      return src;
    }
    // Lexical containment check: abs must be inside cwd, no '..' escapes.
    const relFromCwd = path.relative(options.cwd, abs);
    if (
      relFromCwd === "" ||
      relFromCwd.startsWith("..") ||
      path.isAbsolute(relFromCwd)
    ) {
      byAbsSrc.set(src, { src });
      return src;
    }
    // Also reject if the original src text contained '..' segments — the
    // tests want '..' to fail even when it resolves inside cwd, because
    // a deck persisted with '..' would mean something different in a
    // different environment.
    if (src.split(/[\\/]+/).some((part) => part === "..")) {
      byAbsSrc.set(src, { src });
      return src;
    }
    // Resolve the final target before reading: stat/readFile follow
    // symlinks, so a symlink under cwd could otherwise smuggle an outside
    // file into the presentation asset directory.
    let realAbs: string;
    let stat;
    try {
      realAbs = await fs.realpath(abs);
      stat = await fs.stat(realAbs);
    } catch {
      byAbsSrc.set(src, { src });
      return src;
    }
    const realRelFromCwd = path.relative(realCwd, realAbs);
    if (
      realRelFromCwd === "" ||
      realRelFromCwd.startsWith("..") ||
      path.isAbsolute(realRelFromCwd)
    ) {
      byAbsSrc.set(src, { src });
      return src;
    }
    if (!stat.isFile()) {
      byAbsSrc.set(src, { src });
      return src;
    }
    // Read once for hashing + copying. Asset files are images (KB–MB);
    // streaming would complicate dedupe without meaningful payoff here.
    const bytes = await fs.readFile(realAbs);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const existingForHash = byContentHash.get(hash);
    if (existingForHash) {
      byAbsSrc.set(src, { src: existingForHash });
      return existingForHash;
    }
    const baseName = path.basename(abs);
    let finalName = baseName;
    if (usedNames.has(finalName)) {
      finalName = `${hash.slice(0, 8)}-${baseName}`;
    }
    usedNames.add(finalName);
    await ensureTargetDir();
    const dest = path.join(options.targetDir, finalName);
    await fs.writeFile(dest, bytes);
    const copy: PreparedLocalAssetCopy = { from: abs, to: dest };
    copied.push(copy);
    byContentHash.set(hash, finalName);
    byAbsSrc.set(src, { src: finalName, copy });
    return finalName;
  };

  const rewriteImage = async (
    image: PresentationImage | undefined,
  ): Promise<PresentationImage | undefined> => {
    if (!image || typeof image.src !== "string") return image;
    const next = await tryResolve(image.src);
    if (next === image.src) return image;
    return { ...image, src: next };
  };

  // Slides first so we can short-circuit when nothing changes.
  let changed = false;
  const nextSlides: PresentationSlide[] = [];
  for (const slide of deck.slides) {
    const nextImage = await rewriteImage(slide.image);
    if (nextImage !== slide.image) {
      changed = true;
      // exactOptionalPropertyTypes: only set `image` when it's defined.
      const { image: _omit, ...rest } = slide;
      void _omit;
      nextSlides.push(nextImage ? { ...rest, image: nextImage } : { ...rest });
    } else {
      nextSlides.push(slide);
    }
  }
  const nextLogo = await rewriteImage(deck.logo);
  if (nextLogo !== deck.logo) changed = true;

  if (!changed) return { deck, copied };
  const { logo: _omitLogo, ...deckRest } = deck;
  void _omitLogo;
  return {
    deck: nextLogo
      ? { ...deckRest, slides: nextSlides, logo: nextLogo }
      : { ...deckRest, slides: nextSlides },
    copied,
  };
}

/**
 * Returns the absolute filesystem path for an asset-src string when one
 * is unambiguously implied, or undefined for srcs that aren't local-file
 * references (data:, https://, bare relative names, etc.).
 */
function absolutePathFor(src: string): string | undefined {
  if (FILE_URI_PATTERN.test(src)) {
    try {
      return fileURLToPath(src);
    } catch {
      return undefined;
    }
  }
  if (ABSOLUTE_PATH_PATTERN.test(src)) return src;
  return undefined;
}
