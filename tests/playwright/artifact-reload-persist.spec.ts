import { expect, test } from "@playwright/test";

/**
 * Persistence / history-path regression: an artifact image that rendered once
 * must still render AND load its bytes after a full page reload. This exercises
 * the on-disk history loader (the path that survives a refresh) separately from
 * the live realtime path (artifact-live-render.spec.ts). It also re-confirms
 * the byte-serving route serves a 200 on a COLD load, where the session is only
 * listed and lazily opened — the exact PR #205 scenario.
 */
test("an artifact image still renders and loads after a full page reload", async ({ page }) => {
  const expectArtifactLoads = async () => {
    const img = page.locator('[data-testid="artifact-image"]').first();
    await expect(img).toBeVisible();
    await expect(img).toHaveJSProperty("naturalWidth", 2, { timeout: 15_000 });
  };

  await page.goto("/");
  await expect(page.getByRole("link", { name: /^Artifact image session\b/ })).toBeVisible();
  await page.getByRole("link", { name: /^Artifact image session\b/ }).click();
  await expect(page.getByText("Seeded session artifact image").first()).toBeVisible();
  await expectArtifactLoads();

  // Full document reload — the timeline is rebuilt from /messages (history
  // path), and the artifact bytes are re-fetched from the extension route.
  let reloadArtifactStatus: number | undefined;
  page.on("response", (resp) => {
    if (resp.url().includes("/artifacts/")) reloadArtifactStatus = resp.status();
  });
  await page.reload();

  await expect(page.getByText("Seeded session artifact image").first()).toBeVisible();
  await expectArtifactLoads();

  expect(
    reloadArtifactStatus,
    `artifact request after reload returned ${reloadArtifactStatus}`,
  ).toBe(200);
});
