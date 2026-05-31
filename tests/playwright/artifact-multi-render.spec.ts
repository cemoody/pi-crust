import { expect, test } from "@playwright/test";

/**
 * Multi-artifact coverage: a session can carry more than one artifact image
 * (each its own custom_message + on-disk file) plus a non-image artifact. This
 * guards against regressions where only the FIRST artifact's bytes load, or
 * where a non-image representation breaks the sibling image loads.
 */
test("renders multiple artifact images in one session, all loading their bytes", async ({ page }) => {
  const artifactStatuses = new Map<string, number>();
  page.on("response", (resp) => {
    if (resp.url().includes("/artifacts/")) artifactStatuses.set(resp.url(), resp.status());
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: /^Artifact multi session\b/ })).toBeVisible();
  await page.getByRole("link", { name: /^Artifact multi session\b/ }).click();

  // Both captions render.
  await expect(page.getByText("Multi artifact image A").first()).toBeVisible();
  await expect(page.getByText("Multi artifact image B").first()).toBeVisible();
  await expect(page.getByText("Multi artifact data").first()).toBeVisible();

  // Every artifact <img> must load its bytes (seeded 2x2 PNGs).
  const imgs = page.locator('[data-testid="artifact-image"]');
  await expect(imgs).toHaveCount(2, { timeout: 15_000 });
  const count = await imgs.count();
  expect(count, "expected two artifact images").toBe(2);
  for (let i = 0; i < count; i += 1) {
    await expect(imgs.nth(i)).toHaveJSProperty("naturalWidth", 2, { timeout: 15_000 });
  }

  // Both image artifact byte requests returned 200. (The non-image JSON
  // artifact is rendered without an <img>, so we don't require a byte fetch.)
  const pngRequests = [...artifactStatuses.entries()].filter(([url]) => url.endsWith(".png"));
  expect(pngRequests.length, "expected at least two png artifact requests").toBeGreaterThanOrEqual(2);
  for (const [url, status] of pngRequests) {
    expect(status, `artifact ${url} returned ${status}`).toBe(200);
  }
});
