import { expect, test } from "@playwright/test";

test("presentation artifact renders preview and present modal", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Presentation artifact session\b/ }).click();

  await expect(page.getByText("Executive Signal Brief").first()).toBeVisible();
  await expect(page.locator('[data-testid="artifact-presentation"]')).toBeVisible();
  await expect(page.locator('[data-testid="artifact-presentation-preview"]')).toBeVisible();
  await expect(page.getByText("3 slides")).toBeVisible();

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
