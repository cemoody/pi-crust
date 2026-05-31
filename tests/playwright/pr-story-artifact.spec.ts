import { expect, test } from "@playwright/test";

/**
 * Reload-persistence guard for the PR Story tool artifact (P1).
 *
 * The show_pr_story tool emits its walkthrough as a tool-result artifact
 * (details.piRemoteControlArtifact = { kind: "pr-story", data }). This spec
 * attaches to a seeded session whose persisted /messages payload carries that
 * tool artifact, and asserts the PR Story card renders from the persisted
 * payload ALONE — no live SSE involved — i.e. it survives a full page reload
 * via the history-loader path. Mirrors the presentation tool-reload guard.
 *
 * Regression class: if /api/sessions/:id/messages ever dropped the tool
 * result's details.piRemoteControlArtifact (the way it once did for
 * presentations), the reader would show raw JSON / a fallback instead of the
 * inline PR Story card after a reload.
 */
test("tool-result PR Story artifact renders inline and survives a page reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /^PR Story tool reload\b/ }).click();

  // Card renders from the persisted /messages payload (history path), not raw
  // JSON and not a fallback.
  const card = page.locator('[data-testid="artifact-pr-story"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("Worker pool review tour");
  await expect(card).toContainText("octo/svc#7");
  await expect(card).not.toContainText("schemaVersion");
  await expect(page.locator('[data-testid="artifact-fallback"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open story" })).toBeVisible();

  // Open the reader and navigate frames to prove the full story payload (not a
  // truncated stub) round-trips through the reload/history path.
  await page.getByRole("button", { name: "Open story" }).click();
  await expect(page.getByRole("dialog", { name: /Worker pool review tour PR Story/ })).toBeVisible();
  await expect(page.getByLabel("src/dispatch.ts diff")).toContainText("WorkerPool");

  // Now reload the whole page and confirm the card still renders (pure history
  // path, no live events at all).
  await page.reload();
  await expect(page.getByRole("heading", { name: /^PR Story tool reload/ })).toBeVisible();
  const reloaded = page.locator('[data-testid="artifact-pr-story"]');
  await expect(reloaded).toBeVisible();
  await expect(reloaded).toContainText("Worker pool review tour");
  await expect(page.getByRole("button", { name: "Open story" })).toBeVisible();
});
