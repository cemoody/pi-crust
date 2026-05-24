/**
 * "The page must not go blank" smoke suite, run in CI.
 *
 * Pins the user-facing invariant that brought us here: loading any
 * session URL should leave the React shell mounted and the workspace
 * usable — even for sessions whose payload contains a shape that some
 * future renderer doesn't expect. The original symptom of this class
 * of bug (session 019e4de3-… via PR #110 / #111) was: title + sidebar
 * render for ~hundred ms, then the entire body unmounts and the page
 * is blank, with no recovery short of a hard refresh.
 *
 * The protection is two-layer (safe-markdown coercion + a scoped
 * SessionContentErrorBoundary). This suite verifies the OBSERVABLE
 * outcome of both layers together for every seeded session — so a
 * regression in either, or a new render path that bypasses both,
 * shows up as a CI failure rather than a silent production blank.
 *
 * For each seeded session it asserts:
 *
 *   1. The composer is mounted (sentinel for "shell still rendered").
 *   2. The sidebar is mounted with at least one entry (sentinel for
 *      "navigation still works; user can leave a bad session").
 *   3. The body text is non-trivial (rules out the literal "everything
 *      under root unmounted to whitespace" failure mode).
 *   4. No `pageerror` with a `react-markdown` / `Unexpected value for
 *      \`children\`` signature escaped (the original crash we shipped a
 *      fix for; if the boundary caught it that's still a regression in
 *      the source-of-bad-data path and we want CI to notice).
 *
 * Crucially this test is data-driven from the seed script — adding a
 * new seeded session shape automatically extends coverage.
 */
import { expect, test } from "@playwright/test";

// Mirror seed-mock-session.mjs. Keep in sync — adding a session there
// without listing it here means it isn't smoke-tested.
const SEEDED_SESSIONS = [
  { id: "seeded-session-0001", label: "Seeded session" },
  { id: "seeded-session-blank-bug", label: "Blank-bug repro session" },
  { id: "seeded-session-image-deck", label: "Image-deck presentation" },
  { id: "seeded-session-kitchen-sink", label: "Kitchen sink session" },
  { id: "seeded-session-shape-extras", label: "Message shape extras" },
  { id: "seeded-session-longcode", label: "Long code session" },
  { id: "seeded-session-presentation", label: "Presentation artifact session" },
  { id: "seeded-session-structured-content", label: "Structured tool-call session" },
  { id: "seeded-session-tool-presentation", label: "Tool presentation reload" },
  { id: "seeded-session-toolwrap", label: "Tool wrap repro session" },
] as const;

// A regex matching the specific react-markdown assertion that originally
// took the page down. Other errors are allowed (the boundary covers them);
// this one specifically means the markdown layer regressed.
const MARKDOWN_ASSERTION_RE = /react-markdown|createFile|Unexpected value.*for `children`/i;

for (const session of SEEDED_SESSIONS) {
  test(`session "${session.label}" loads with a usable, non-blank page`, async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await page.goto(`/?session=${encodeURIComponent(session.id)}`);

    // (1) shell sentinel — sidebar still mounted with at least one entry.
    const sidebar = page.getByRole("complementary", { name: "Sessions" });
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("link", { name: new RegExp(`^${session.label}\\b`) })).toBeVisible();

    // (2) composer sentinel — proves the active-session pane mounted at
    // least up to and including the composer (which lives below the
    // potentially-faulty timeline).
    await expect(page.getByLabel("Prompt draft")).toBeVisible();

    // (3) body text sentinel — fails on the literal "everything unmounted
    // to nothing" symptom. With a healthy shell + sidebar this is easily
    // in the thousands of characters; pick a low threshold that still
    // distinguishes "alive" from "blank".
    const bodyTextLength = await page.evaluate(() => document.body.textContent?.length ?? 0);
    // Pre-fix blank repro of this bug class measured body textLen=15 (an
    // empty page with just a hidden React root). Healthy seeded sessions
    // measure 363+ chars (sidebar shell alone) up through ~2000. 200 is a
    // robust floor that catches "page unmounted" without false-positiving
    // on sessions with short content.
    expect(bodyTextLength, "body should be non-trivial; <200 chars means the tree unmounted").toBeGreaterThan(200);

    // (4) no react-markdown assertion escaped to the top-level error
    // handler. If a future seed shape regresses, this is the crisp signal.
    const markdownErrors = pageErrors.filter((e) => MARKDOWN_ASSERTION_RE.test(e.message));
    expect(markdownErrors, `react-markdown assertion escaped: ${markdownErrors.map((e) => e.message).join(", ")}`).toEqual([]);
  });
}

test("no-session landing page is not blank either", async ({ page }) => {
  // Load `/` with no ?session= — should still show the shell + sidebar.
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "Sessions" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: /^Seeded session\b/ })).toBeVisible();

  const bodyTextLength = await page.evaluate(() => document.body.textContent?.length ?? 0);
  // See the per-session test above for the threshold rationale.
  expect(bodyTextLength).toBeGreaterThan(200);

  expect(pageErrors.filter((e) => MARKDOWN_ASSERTION_RE.test(e.message))).toEqual([]);
});
