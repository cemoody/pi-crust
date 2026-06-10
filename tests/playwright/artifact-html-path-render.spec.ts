import { expect, test } from "@playwright/test";

// Regression test for the broken path-backed HTML artifact render reported by
// the user. When `show_artifact` is called with kind:"html" and a `path`
// (instead of an inline `html` string), the extension emits a tool result whose
// artifact carries { kind:"html", path, url, mimeType:"text/html" } but NO
// inline `html` field. The MessageTimeline ArtifactPreview only renders the
// <iframe> when `artifact.html` is present, so this case falls through to
// ArtifactFallback and dumps the raw JSON descriptor into a <pre> block — which
// is exactly what the screenshot showed.
//
// This test opens the seeded "HTML path artifact" session and asserts the HTML
// actually renders inside a sandboxed iframe. Before the fix it FAILS: there is
// no artifact-html iframe and the JSON descriptor (with "mimeType": "text/html")
// is visible as text instead.
test("renders a path-backed HTML artifact in an iframe, not as raw JSON", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: /^HTML path artifact\b/ })).toBeVisible();
  await page.getByRole("link", { name: /^HTML path artifact\b/ }).click();

  // The artifact output area should render (as a preview, not raw JSON).
  await expect(page.locator(".artifact-preview").first()).toBeVisible();

  // BUG REPRO: the path-backed html artifact must render inside an iframe.
  const iframe = page.locator("iframe.artifact-html, figure.artifact-html iframe").first();
  await expect(iframe, "expected the HTML artifact to render in an <iframe>").toBeVisible({ timeout: 10_000 });

  // And the iframe must contain the actual HTML body, not be empty.
  const heading = iframe.contentFrame().locator("#seeded-html-heading");
  await expect(heading).toHaveText(/HD shingle prices/, { timeout: 10_000 });

  // The raw JSON descriptor must NOT be shown as a fallback <pre> block.
  await expect(
    page.locator("pre", { hasText: '"mimeType": "text/html"' }),
    "the raw artifact JSON should not be dumped to the page",
  ).toHaveCount(0);
});
