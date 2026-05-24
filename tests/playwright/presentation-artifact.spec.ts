import { expect, test } from "@playwright/test";

test("presentation artifact renders preview and present modal", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /^Presentation artifact session\b/ }).click();

  await expect(page.getByText("Executive Signal Brief").first()).toBeVisible();
  await expect(page.locator('[data-testid="artifact-presentation"]')).toBeVisible();
  await expect(page.locator('[data-testid="artifact-presentation-preview"]')).toBeVisible();
  await expect(page.getByText("4 slides")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download HTML" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("executive-signal-brief.html");
  await page.screenshot({ path: "test-results/presentation-artifact-card.png", fullPage: true });

  await page.getByRole("button", { name: "Present deck" }).click();

  await expect(page.getByRole("dialog", { name: /Executive Signal Brief presentation/ })).toBeVisible();
  await expect(page.locator('[data-testid="artifact-presentation-modal"]')).toBeVisible();
  await page.screenshot({ path: "test-results/presentation-artifact-modal.png", fullPage: true });
  await page.getByRole("button", { name: "Close presentation" }).click();
  await expect(page.getByRole("dialog", { name: /Executive Signal Brief presentation/ })).toHaveCount(0);
});

test("tool-result presentation artifact renders inline after page reload", async ({ page }) => {
  // Reproduces the bug where /api/sessions/:id/messages dropped the tool
  // result's details.piRemoteControlArtifact, leaving the pi-crust showing raw
  // JSON instead of the inline slide preview after a page reload.
  await page.goto("/");
  await page.getByRole("link", { name: /^Tool presentation reload\b/ }).click();

  // Card should render from the persisted /messages payload alone (no
  // live SSE involved here — the pi-crust is reading the mock-session JSON
  // through the API, exactly like a real page reload).
  await expect(page.locator('[data-testid="artifact-presentation"]')).toBeVisible();
  await expect(page.locator('[data-testid="artifact-presentation-preview"]')).toBeVisible();
  // The deck title appears in the card header (outside the iframe).
  await expect(
    page.locator('[data-testid="artifact-presentation"] .presentation-card-header').getByText("Tool-result Signal Brief"),
  ).toBeVisible();
  await expect(page.locator('[data-testid="artifact-presentation"]').getByText("2 slides")).toBeVisible();

  // Spot-check: opening the Present modal still works.
  await page.getByRole("button", { name: "Present deck" }).click();
  await expect(page.getByRole("dialog", { name: /Tool-result Signal Brief presentation/ })).toBeVisible();
  await page.getByRole("button", { name: "Close presentation" }).click();
});
