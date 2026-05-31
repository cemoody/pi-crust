import { expect, test } from "@playwright/test";

/**
 * End-to-end regression test for an artifact emitted MID-SESSION (not pre-
 * seeded). It drives the mock adapter's `@@artifact` directive, which behaves
 * exactly like the @cemoody/pi-artifact `display(...)` tool: it writes a real
 * PNG to <cwd>/.pi/artifacts/<sessionId>/ and emits a paired message_start/
 * message_end carrying a `role: "custom"`, `customType: "artifact"` payload
 * over the live realtime gateway.
 *
 * What this guards (the union of the two production bugs we fixed):
 *   - PR #205 (byte serving): the artifact image URL must serve 200 bytes so
 *     the <img> decodes (naturalWidth > 0). This is the primary assertion.
 *   - The artifact must render in the timeline for a session whose artifact was
 *     produced during the active turn — covering the live event AND the
 *     scheduled /messages refetch that follows it.
 *
 * The pure live-reducer isolation (that message_start/message_end alone render
 * the custom artifact, independent of any refetch) is covered at the unit level
 * by tests/unit/session-dashboard-realtime-invariants.test.ts. The on-cold-load
 * history path is covered by artifact-image-render.spec.ts.
 */
test("a live-streamed artifact image renders and loads without a page reload", async ({ page }) => {
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
  await page.getByRole("link", { name: /^Seeded session\b/ }).click();
  await expect(page.getByRole("heading", { name: /^Seeded session/ })).toBeVisible();

  // Drive the live artifact emission. The mock writes a real 2x2 PNG to disk
  // and emits message_start/message_end with the custom artifact payload.
  await page.getByLabel("Prompt draft").fill("@@artifact");
  await page.getByRole("button", { name: "Send" }).click();

  // The caption must appear in the timeline purely from the LIVE event — no
  // reload. If the realtime reducer dropped the custom message this never shows.
  await expect(page.getByText("Live artifact render").first()).toBeVisible({ timeout: 15_000 });

  // And the live <img> bytes must load (naturalWidth 2 for the seeded 2x2 PNG).
  const img = page.locator('[data-testid="artifact-image"]').first();
  await expect(img).toBeVisible();
  await expect(img).toHaveJSProperty("naturalWidth", 2, { timeout: 15_000 });

  // Crucially: this assertion is reached WITHOUT any page.reload() call, so it
  // proves the live path (not the history-loader path) renders the artifact.

  const artifactReq = artifactResponses.find((r) => r.url.includes("/artifacts/"));
  expect(artifactReq, "expected a live artifact image request").toBeTruthy();
  expect(
    artifactReq?.status,
    `live artifact request failed: ${artifactReq?.status} ${artifactReq?.body}`,
  ).toBe(200);
});
