import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const DECK_TITLE = "Executive Signal Brief";
const DECK_ID = "executive-signal-brief";

async function openDeck(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: /^Presentation artifact session\b/ }).click();
  await expect(page.locator('[data-testid="artifact-presentation"]')).toBeVisible();
}

async function openModal(page: Page) {
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect(page.getByRole("dialog", { name: new RegExp(`${DECK_TITLE} presentation`) })).toBeVisible();
}

async function enterEditMode(page: Page) {
  await page.getByRole("button", { name: /^Edit/ }).click();
  // Re-render of the iframe is async; wait until at least one editable
  // element shows up inside the modal frame.
  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');
  await expect(modal.locator("[contenteditable]").first()).toBeVisible();
}

/** Navigate to a specific slide index by clicking the deck's `[data-next]`
 *  button N times. Inactive slides are display:none, so the test must
 *  navigate before interacting with anything past slide 0. */
async function gotoSlide(page: Page, target: number) {
  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');
  for (let i = 0; i < target; i += 1) {
    await modal.locator("[data-next]").click();
  }
  // Ensure the target slide is now visible.
  await expect(modal.locator(`section.slide.active[data-slide-index="${target}"]`)).toBeVisible();
}

function projectRoot(): string {
  // Decks are persisted under `<session.cwd>/.pi/presentations/...`. The
  // mock seeder uses the project root as the cwd for every session.
  return process.env.PI_CRUST_PROJECT_ROOT ?? process.cwd();
}

async function readPersistedDeck(sessionId: string): Promise<unknown> {
  const file = path.join(projectRoot(), ".pi", "presentations", sessionId, `${DECK_ID}.deck.json`);
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

test("preview iframe has no editable text nodes (read-only)", async ({ page }) => {
  await openDeck(page);
  const preview = page.frameLocator('[data-testid="artifact-presentation-preview"]');
  await expect(preview.locator("[contenteditable]")).toHaveCount(0);
});

test("entering edit mode in the modal exposes contenteditable elements with JSON pointers", async ({ page }) => {
  await openDeck(page);
  await openModal(page);
  // Before clicking Edit, no contenteditable elements
  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');
  await expect(modal.locator("[contenteditable]")).toHaveCount(0);

  await enterEditMode(page);
  await expect(modal.locator('[data-deck-path="/slides/0/title"]')).toBeVisible();
  await expect(
    modal.locator('[data-deck-path="/slides/0/title"][contenteditable="plaintext-only"]'),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/presentation-editable-modal.png", fullPage: true });
});

test("editing a title and a bullet PATCHes the server with both ops", async ({ page }) => {
  await openDeck(page);
  await openModal(page);
  await enterEditMode(page);
  await gotoSlide(page, 1);
  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');

  const patchPromise = page.waitForRequest(
    (req) => req.method() === "PATCH" && /\/deck\.json$/.test(req.url()),
    { timeout: 5000 },
  );

  const title = modal.locator('[data-deck-path="/slides/1/title"]');
  await title.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Edited heading");

  const bullet = modal.locator('[data-deck-path="/slides/1/bullets/2"]'); // string bullet "Pricing pressure…"
  await bullet.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Edited bullet");

  const req = await patchPromise;
  const body = JSON.parse(req.postData() ?? "{}");
  const ops = body.ops as { op: string; path: string; value: string }[];
  expect(ops.find((o) => o.path === "/slides/1/title")?.value).toBe("Edited heading");
  expect(ops.find((o) => o.path === "/slides/1/bullets/2")?.value).toBe("Edited bullet");

  // UI reflects edits immediately.
  await expect(title).toHaveText("Edited heading");
  await expect(bullet).toHaveText("Edited bullet");
});

test("edits persist across a full page reload", async ({ page }) => {
  await openDeck(page);
  await openModal(page);
  await enterEditMode(page);
  await gotoSlide(page, 1);

  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');
  const title = modal.locator('[data-deck-path="/slides/1/title"]');
  await title.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Persisted heading");

  // Wait for the PATCH to flush.
  await page.waitForRequest((r) => r.method() === "PATCH" && /\/deck\.json$/.test(r.url()));
  await page.waitForResponse((r) => r.request().method() === "PATCH" && /\/deck\.json$/.test(r.url()));
  await page.getByRole("button", { name: "Close presentation" }).click();

  await page.reload();
  await page.getByRole("link", { name: /^Presentation artifact session\b/ }).click();
  await openModal(page);
  await enterEditMode(page);
  await gotoSlide(page, 1);
  const reloadedTitle = page
    .frameLocator('[data-testid="artifact-presentation-modal"]')
    .locator('[data-deck-path="/slides/1/title"]');
  await expect(reloadedTitle).toHaveText("Persisted heading");

  await page.screenshot({ path: "test-results/presentation-editable-after-reload.png", fullPage: true });
});

test("edits are persisted to disk under .pi/presentations", async ({ page }) => {
  await openDeck(page);
  await openModal(page);
  await enterEditMode(page);
  await gotoSlide(page, 1);
  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');
  await modal.locator('[data-deck-path="/slides/1/title"]').click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Disk-persisted heading");
  await page.waitForResponse((r) => r.request().method() === "PATCH" && /\/deck\.json$/.test(r.url()));
  await page.getByRole("button", { name: "Close presentation" }).click();

  const envelope = (await readPersistedDeck("seeded-session-presentation")) as {
    deck: { slides: { title?: string }[] };
  };
  expect(envelope.deck.slides[1]?.title).toBe("Disk-persisted heading");
});

test("forbidden edits are rejected by the server with 400", async ({ page }) => {
  await openDeck(page);
  await openModal(page);
  await enterEditMode(page);
  // Programmatically send a forbidden op via window.postMessage. The card
  // listener may filter this client-side; we additionally assert the
  // server-side guard catches it if the client lets it through.
  const responsePromise = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && /\/deck\.json$/.test(r.url()),
    { timeout: 1500 },
  ).catch(() => null);

  await page.evaluate((deckId) => {
    window.postMessage(
      { type: "pi-deck-edit", deckId, path: "/slides/2/html", value: "<b>injected</b>" },
      "*",
    );
  }, DECK_ID);

  const response = await responsePromise;
  if (response !== null) {
    expect(response.status()).toBe(400);
  }
  // The visible slide content must not contain the injected HTML.
  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');
  await expect(modal.locator("text=injected")).toHaveCount(0);
});

test("rapid edits debounce: ≤2 PATCH requests for 5 keystrokes", async ({ page }) => {
  await openDeck(page);
  await openModal(page);
  await enterEditMode(page);
  await gotoSlide(page, 1);
  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');

  const patches: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && /\/deck\.json$/.test(req.url())) patches.push(req.url());
  });

  const title = modal.locator('[data-deck-path="/slides/1/title"]');
  await title.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("HELLO", { delay: 30 });
  // Blur to trigger flush.
  await page.keyboard.press("Tab");
  // Settle.
  await page.waitForTimeout(800);
  expect(patches.length).toBeGreaterThanOrEqual(1);
  expect(patches.length).toBeLessThanOrEqual(2);
});

test("templated slides show a read-only banner in edit mode", async ({ page }) => {
  await openDeck(page);
  await openModal(page);
  await enterEditMode(page);
  // The seeded deck includes one slide using slide.html. The banner is
  // rendered in the card toolbar (outside the iframe) once edit mode is on
  // and the deck contains any templated slides.
  await expect(page.getByText(/Edit not supported for templated slides/i)).toBeVisible();
  // And inside that slide's iframe section, no contenteditable elements.
  const modal = page.frameLocator('[data-testid="artifact-presentation-modal"]');
  await expect(modal.locator('section[data-non-editable="templated"] [contenteditable]')).toHaveCount(0);
});
