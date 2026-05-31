import { expect, test } from "@playwright/test";

// Reproduction (NOT a fix) for the user-reported broken artifact render in the
// fresh session 019e7bc0-... ("display the screenshots"). The artifact <img>
// elements render but their bytes never load because the artifact-serving
// route /api/sessions/:id/artifacts/:file returns HTTP 500 "session has no cwd".
//
// Run against the already-running live dev server.
const BASE = process.env.REPRO_BASE_URL ?? "http://127.0.0.1:5173";
const SESSION_UUID = "019e7bc0-97f4-737f-98b2-e89532545ddb";
const SESSION_FULL = "2026-05-31T01-57-59-924Z_019e7bc0-97f4-737f-98b2-e89532545ddb";
const ARTIFACT_PATH = `/api/sessions/${SESSION_FULL}/artifacts/6454f27c3eec659a.png`;

test("repro: artifact image request returns 500 'session has no cwd'", async ({ request }) => {
  const res = await request.get(`${BASE}${ARTIFACT_PATH}`);
  console.log("artifact GET status:", res.status());
  const body = await res.text();
  console.log("artifact GET body:", body);
  // Document the broken behavior (this is the reproduction, not a passing fix).
  expect(res.status()).toBe(500);
  expect(body).toContain("session has no cwd");
});

test("repro: open the session in the UI and observe broken artifact images", async ({ page }) => {
  const failed: { url: string; status: number; body: string }[] = [];
  page.on("response", async (resp) => {
    if (resp.url().includes("/artifacts/") && resp.status() >= 400) {
      let body = "";
      try { body = await resp.text(); } catch { /* ignore */ }
      failed.push({ url: resp.url(), status: resp.status(), body });
    }
  });

  // The SPA selects a session via the ?session=<uuid> query param.
  await page.goto(`${BASE}/?session=${SESSION_UUID}`, { waitUntil: "networkidle" });

  // Give the timeline time to render and fire artifact image requests.
  await page.waitForTimeout(4000);

  const imgs = page.locator('img.artifact-image, [data-testid="artifact-image"]');
  const count = await imgs.count();
  console.log("artifact <img> count:", count);

  let broken = 0;
  for (let i = 0; i < count; i++) {
    const nw = await imgs.nth(i).evaluate((el) => (el as HTMLImageElement).naturalWidth).catch(() => -1);
    const src = await imgs.nth(i).getAttribute("src");
    console.log(`img[${i}] naturalWidth=${nw} src=${src}`);
    if (nw === 0) broken++;
  }
  console.log("failed artifact responses:", JSON.stringify(failed, null, 2));

  await page.screenshot({ path: "tests/repro/artifact-500-repro.png", fullPage: true });

  // Reproduction expectation: at least one artifact image failed to load
  // (naturalWidth 0) and the server returned a 500 for the artifact URL.
  expect(failed.some((f) => f.status === 500 && f.body.includes("session has no cwd"))).toBe(true);
});
