import { expect, test } from "@playwright/test";

// E2E coverage for the Download control added to the inline show_artifact
// widget frame (MessageTimeline ArtifactPreview). Two cases:
//   1. File-backed artifact (kind:"html" + path/url): the header link points
//      at the served artifact-file source and downloads under the backing
//      file's basename.
//   2. Inline artifact (kind:"html" with an inline `html` string): the header
//      link is a same-origin blob: URL that fires a real browser download
//      named after the artifact title.

test("path-backed HTML artifact preview exposes a file-backed Download link", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: /^HTML path artifact\b/ })).toBeVisible();
  await page.getByRole("link", { name: /^HTML path artifact\b/ }).click();

  const preview = page.locator("figure.artifact-html").first();
  await expect(preview).toBeVisible({ timeout: 10_000 });

  const download = preview.getByRole("link", { name: "Download artifact" });
  await expect(download).toBeVisible();

  // File-backed artifacts download straight from their served source, named
  // after the backing file's basename. (The `download` attribute only forces a
  // save when the href is same-origin — true in production where the API and
  // web app share an origin — so here we assert the wiring, not the event.)
  await expect(download).toHaveAttribute("download", "seeded-html-artifact.html");
  expect(await download.getAttribute("href")).toContain("/api/artifact-file?path=");
});

test("inline HTML artifact preview fires a real Download and matches the snapshot", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: /^HTML inline artifact\b/ })).toBeVisible();
  await page.getByRole("link", { name: /^HTML inline artifact\b/ }).click();

  const preview = page.locator("figure.artifact-html").first();
  await expect(preview).toBeVisible({ timeout: 10_000 });

  const download = preview.getByRole("link", { name: "Download artifact" });
  await expect(download).toBeVisible();
  // Inline artifacts become client-side blob downloads named after the title.
  await expect(download).toHaveAttribute("download", "qxo-gaf-qa-report.html");
  expect(await download.getAttribute("href")).toMatch(/^blob:/);

  // Trigger the download and confirm the browser accepts it with the expected
  // filename — proves the control is a real, wired-up download.
  const [downloadEvent] = await Promise.all([
    page.waitForEvent("download"),
    download.click(),
  ]);
  expect(downloadEvent.suggestedFilename()).toBe("qxo-gaf-qa-report.html");

  // Screenshot the rendered preview + download button for visual review.
  await preview.screenshot({ path: "test-results/artifact-download-button.png" });
});
