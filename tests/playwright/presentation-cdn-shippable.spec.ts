/**
 * TDD red-phase e2e for the "Download HTML → upload to CDN → it just works"
 * guarantee.
 *
 * The killer assertion: load the compiled file via file:// in a context that
 * records every request, and assert NO non-file:/data: requests are attempted
 * during page load. That is the operational definition of "CDN shippable".
 *
 * We bypass the WUI download UI here (covered by presentation-artifact.spec.ts)
 * and exercise the production compile function directly. A separate wiring
 * test asserts the WUI download path is wired to the same function.
 *
 * Until `src/presentations/standalone.ts` and the image-bearing seed land,
 * these tests will fail at import/seed time.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// These imports drive the production API we want. Until the standalone
// compile module exists, the suite fails at load time — that's the red.
import { compileStandalonePresentationHtml } from "../../src/presentations/standalone.js";

const SESSION_ROOT = path.resolve(".tmp/playwright-sessions");
const PROJECT_ROOT = path.resolve(".");
const PRESENTATIONS_DIR = path.join(PROJECT_ROOT, ".pi/presentations");

interface SeededDeck {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly deckSpec: Record<string, unknown>;
  readonly assetsDir: string;
}

async function loadSeededDeck(sessionFileBasename: string): Promise<SeededDeck> {
  const sessionFile = path.join(SESSION_ROOT, sessionFileBasename);
  const raw = JSON.parse(await readFile(sessionFile, "utf8"));
  const sessionId: string = raw.id;
  const artifactMessage = (raw.messages as Array<Record<string, unknown>>).find(
    (m) => m.customType === "artifact",
  );
  if (!artifactMessage) throw new Error(`no artifact in ${sessionFile}`);
  const details = artifactMessage.details as { artifacts: Array<{ spec: Record<string, unknown> }> };
  const first = details.artifacts[0];
  if (!first) throw new Error(`no artifact spec in ${sessionFile}`);
  const deckSpec = first.spec;
  const assetsDir = path.join(PRESENTATIONS_DIR, sessionId);
  return { sessionId, sessionFile, deckSpec, assetsDir };
}

async function fetchAssetFromSession(assetsDir: string) {
  return async (src: string) => {
    if (src.startsWith("data:") || /^https?:\/\//i.test(src)) {
      throw new Error(`fetchAssetFromSession should not be called for absolute src: ${src}`);
    }
    const full = path.resolve(assetsDir, src);
    if (!full.startsWith(assetsDir + path.sep)) throw new Error(`path escape: ${src}`);
    const data = await readFile(full);
    const ext = path.extname(src).toLowerCase();
    const mimeType =
      ext === ".png" ? "image/png" :
      ext === ".svg" ? "image/svg+xml" :
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      ext === ".webp" ? "image/webp" :
      "application/octet-stream";
    return { data: new Uint8Array(data), mimeType };
  };
}

interface OfflineLoadResult {
  readonly filePath: string;
  readonly fileSizeBytes: number;
  readonly htmlText: string;
  readonly offlinePage: Page;
  readonly requestUrls: string[];
}

async function compileAndLoadOffline(page: Page, seed: SeededDeck): Promise<OfflineLoadResult> {
  const htmlText = await compileStandalonePresentationHtml(seed.deckSpec as never, {
    fetchAsset: await fetchAssetFromSession(seed.assetsDir),
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-deck-cdn-"));
  const filePath = path.join(dir, "deck.html");
  await writeFile(filePath, htmlText, "utf8");
  const { size } = await stat(filePath);

  const context = await page.context().browser()!.newContext();
  const offlinePage = await context.newPage();
  const requestUrls: string[] = [];
  offlinePage.on("request", (req) => requestUrls.push(req.url()));
  await offlinePage.goto(pathToFileURL(filePath).href, { waitUntil: "load" });
  await offlinePage.waitForLoadState("networkidle").catch(() => undefined);

  return { filePath, fileSizeBytes: size, htmlText, offlinePage, requestUrls };
}

function externalRequests(urls: string[]): string[] {
  return urls.filter((u) => !u.startsWith("file:") && !u.startsWith("data:") && !u.startsWith("about:"));
}

test.describe("Download HTML produces a CDN-shippable single file", () => {
  test("text-only deck: loads offline with zero network requests (baseline)", async ({ page }) => {
    const seed = await loadSeededDeck("0000000000003_seeded-session-presentation.mock-session.json");
    const result = await compileAndLoadOffline(page, seed);

    await expect(result.offlinePage.getByText("Executive Signal Brief").first()).toBeVisible();
    expect(externalRequests(result.requestUrls)).toEqual([]);
  });

  test("image-bearing deck: image renders offline with zero network requests", async ({ page }) => {
    const seed = await loadSeededDeck("0000000000006_seeded-session-image-deck.mock-session.json");
    const result = await compileAndLoadOffline(page, seed);

    await expect(result.offlinePage.getByText("Image-Bearing Deck").first()).toBeVisible();

    const imgStatuses = await result.offlinePage.evaluate(() =>
      Array.from(document.images).map((img) => ({
        src: img.currentSrc || img.src,
        complete: img.complete,
        naturalWidth: img.naturalWidth,
      })),
    );
    expect(imgStatuses.length, "deck should have at least one <img>").toBeGreaterThan(0);
    for (const status of imgStatuses) {
      expect(status.complete, `image not complete: ${status.src}`).toBe(true);
      expect(status.naturalWidth, `image failed to load: ${status.src}`).toBeGreaterThan(0);
      expect(status.src.startsWith("data:"), `image is not a data: URI: ${status.src}`).toBe(true);
    }

    expect(externalRequests(result.requestUrls)).toEqual([]);
  });

  test("image-bearing deck: round-trips every bullet from the source spec", async ({ page }) => {
    const seed = await loadSeededDeck("0000000000006_seeded-session-image-deck.mock-session.json");
    const result = await compileAndLoadOffline(page, seed);
    const expectedBullets = [
      "Cover image inlined as a data URI",
      "Diagram inlined as a data URI",
      "Loads offline from any static CDN",
    ];
    for (const bullet of expectedBullets) {
      expect(result.htmlText, `bullet missing from downloaded HTML: ${bullet}`).toContain(bullet);
    }
  });

  test("image-bearing deck: stays under the 2MB single-file size budget", async ({ page }) => {
    const seed = await loadSeededDeck("0000000000006_seeded-session-image-deck.mock-session.json");
    const result = await compileAndLoadOffline(page, seed);
    expect(result.fileSizeBytes).toBeLessThan(2 * 1024 * 1024);
    // Floor — if we suddenly ship a 5KB file, we probably regressed inlining
    // and shipped a deck full of broken refs that just happened to compile.
    expect(result.fileSizeBytes).toBeGreaterThan(5 * 1024);
  });

  test("WUI Download HTML link content matches the production standalone compile", async ({ page }) => {
    // Wiring guard: the bytes downloaded from the UI must match the bytes the
    // production compile function emits for the same deck. This is what
    // prevents the UI from regressing to a non-inlining code path.
    const seed = await loadSeededDeck("0000000000006_seeded-session-image-deck.mock-session.json");
    const expectedHtml = await compileStandalonePresentationHtml(seed.deckSpec as never, {
      fetchAsset: await fetchAssetFromSession(seed.assetsDir),
    });

    await page.goto("/");
    await page.getByRole("button", { name: /^Image-deck presentation\b/ }).click();
    const link = page.getByRole("link", { name: "Download HTML" });
    await link.waitFor();
    const blobHref = await link.getAttribute("href");
    if (!blobHref) throw new Error("Download HTML link has no href");
    const downloadedHtml: string = await page.evaluate(async (href) => {
      const res = await fetch(href);
      return await res.text();
    }, blobHref);

    expect(downloadedHtml).toBe(expectedHtml);
  });
});
