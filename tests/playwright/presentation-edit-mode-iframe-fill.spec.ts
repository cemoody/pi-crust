import { expect, test } from "@playwright/test";

// Regression: the full-screen modal used `display:grid; grid-template-rows:
// auto 1fr`. In EDIT mode an extra in-flow child appears — the
// "Edit not supported for templated slides" banner (and/or the edit-error
// alert). That banner became the 2nd grid child and grabbed the single `1fr`
// row, pushing the iframe into an implicit `auto` row where it collapsed to an
// iframe's ~150px intrinsic height. Result: the slide shrank to a tiny strip
// pinned to the bottom while the rest of the modal went black. Present mode
// (no banner) looked fine.
//
// The fix switches the modal to a flex column where header rows are auto and
// the iframe always flex:1-fills. This test asserts the edit-mode iframe stays
// (nearly) as tall as the present-mode iframe.

async function openModal(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("link", { name: /^Presentation artifact session\b/ }).click();
  await expect(page.locator('[data-testid="artifact-presentation"]')).toBeVisible();
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect(page.locator('[data-testid="artifact-presentation-modal"]')).toBeVisible();
}

test("edit mode keeps the slide iframe full-height (not collapsed by the banner)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openModal(page);

  const iframe = page.locator('[data-testid="artifact-presentation-modal"]');

  // Baseline: present/preview mode (toolbar only, no banner).
  const presentBox = await iframe.boundingBox();
  expect(presentBox).not.toBeNull();
  console.log("present iframe height =", presentBox!.height);

  // Enter edit mode — the seeded deck includes a templated slide so the
  // "Edit not supported for templated slides" banner renders.
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await expect(page.getByText("Edit not supported for templated slides")).toBeVisible();
  // Let layout settle.
  await page.waitForTimeout(150);

  const editBox = await iframe.boundingBox();
  expect(editBox).not.toBeNull();
  console.log("edit iframe height =", editBox!.height);

  const vp = page.viewportSize()!;
  // The iframe must still own essentially all the space below the header rows.
  // Before the fix this dropped to ~150px (an iframe's intrinsic height).
  expect(editBox!.height, "edit-mode iframe should fill the modal, not collapse").toBeGreaterThan(vp.height * 0.7);
  // And it should stay close to the present-mode height (banner is a thin row).
  expect(
    Math.abs(editBox!.height - presentBox!.height),
    "edit-mode iframe height should be within ~60px of present-mode height",
  ).toBeLessThan(60);
});
