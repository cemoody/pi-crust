import { expect, test } from "@playwright/test";

// Regression test for the broken artifact-image render reported by the user:
// a session created via the `display` tool shows an image artifact, but the
// artifact bytes never load because the extension-served route
//   GET /api/sessions/:sessionId/artifacts/:file
// returned HTTP 500 "session has no cwd". Root cause: the pi-crust extension
// host was created WITHOUT a sessions API binding, so the bundled artifacts
// extension's `ctx.sessions.get(...)` was undefined and could never resolve
// the session cwd needed to locate the artifact file on disk.
//
// This test boots the default mock server (which loads the bundled artifacts
// extension) and opens the seeded "Artifact image session". Before the fix the
// <img> stays at naturalWidth 0; after the fix it loads (naturalWidth > 0).
test("renders an image artifact served by the bundled artifacts extension", async ({ page }) => {
  const artifactResponses: { url: string; status: number; body: string }[] = [];
  page.on("response", async (resp) => {
    if (resp.url().includes("/artifacts/")) {
      let body = "";
      if (resp.status() >= 400) {
        try { body = await resp.text(); } catch { /* ignore */ }
      }
      artifactResponses.push({ url: resp.url(), status: resp.status(), body });
    }
  });

  await page.goto("/");
  // Ensure the session list (which populates the server's coldSessionFiles map
  // used for lazy cold-open) has loaded before we open the session.
  await expect(page.getByRole("link", { name: /^Artifact image session\b/ })).toBeVisible();
  await page.getByRole("link", { name: /^Artifact image session\b/ }).click();

  // The artifact caption confirms the custom_message rendered into the timeline.
  await expect(page.getByText("Seeded session artifact image").first()).toBeVisible();

  const img = page.locator('[data-testid="artifact-image"]').first();
  await expect(img).toBeVisible();

  // The artifact bytes must actually load. This is the assertion that fails
  // (naturalWidth === 0) when the artifact route 500s. The seeded PNG is 2x2.
  // Use a generous timeout so the assertion waits for the image to decode
  // rather than racing the initial (pre-listing) request.
  await expect(img).toHaveJSProperty("naturalWidth", 2, { timeout: 15_000 });

  // And the artifact endpoint must return 200, not 500 "session has no cwd".
  const artifactReq = artifactResponses.find((r) => r.url.includes("/artifacts/"));
  expect(artifactReq, "expected an artifact image request").toBeTruthy();
  expect(
    artifactReq?.status,
    `artifact request failed: ${artifactReq?.status} ${artifactReq?.body}`,
  ).toBe(200);
});
