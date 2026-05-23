import { test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Captures README hero / promo screenshots showing off:
 *   - a mobile session list (mobile-first sidebar)
 *   - an active conversation with markdown rendering
 *   - the show_artifact tool rendering a Vega-Lite chart inline
 *   - the show_artifact tool rendering a self-contained HTML dashboard
 *   - a cron-spawned session
 *   - the cron jobs admin page
 *   - the same conversation on desktop, for breadth
 *
 * Output: promo-screenshots/<viewport>/<state>.png
 */

const MOBILE = { name: "iphone-14", width: 390, height: 844 };
const TABLET = { name: "ipad-mini", width: 768, height: 1024 };
const DESKTOP = { name: "desktop", width: 1280, height: 820 };

const OUT_ROOT = path.resolve("promo-screenshots");

async function shot(page: Page, vpName: string, name: string) {
  const dir = path.join(OUT_ROOT, vpName);
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
}

async function selectSession(page: Page, name: RegExp) {
  await page.getByRole("link", { name }).first().click();
  // Mobile drawer slide-out + first-render of artifacts (vega-lite is lazy).
  await page.waitForTimeout(500);
}

/**
 * Vega-Lite is React.lazy + dynamic-imported, then renders an <svg> into a
 * div. waitFor({state:'attached'}) on the wrapper isn't enough — the wrapper
 * exists immediately, but the chart paints seconds later (download + parse +
 * compile of vega-embed, plus a layout pass before the spec's width:'container'
 * picks up the real width). Wait for the actual svg with non-zero width.
 */
async function waitForVegaPaint(page: Page) {
  // Listen for chart-side console errors so failures are diagnosable.
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[browser-error]", m.text());
  });
  page.on("pageerror", (err) => console.log("[browser-pageerror]", err.message));

  await page.locator('[data-testid="artifact-vega-lite"]').first().waitFor({ state: "attached", timeout: 20_000 });
  // Vega-embed is dynamically imported AND its parent uses width:"container"
  // which only resolves after the first layout pass. Poll for the svg with
  // non-zero dimensions; give it a long-ish budget on slow CI / cold caches.
  await page.waitForFunction(() => {
    const svg = document.querySelector('[data-testid="artifact-vega-lite"] svg');
    if (!svg) return false;
    const rect = (svg as SVGElement).getBoundingClientRect();
    return rect.width > 100 && rect.height > 50;
  }, undefined, { timeout: 25_000, polling: 150 });
  // Final paint settle so axis labels finish.
  await page.waitForTimeout(400);
}

async function waitForHtmlArtifact(page: Page, opts: { readonly minDocBytes?: number; readonly settleMs?: number } = {}) {
  await page.locator('[data-testid="artifact-html"]').first().waitFor({ state: "attached", timeout: 10_000 });
  // The iframe uses sandbox="allow-scripts" *without* allow-same-origin, so
  // contentDocument is null to the parent (intentional, for safety). Wait for
  // a non-empty srcdoc + non-zero rect instead, then give the iframe time to
  // actually paint its own document.
  const minDocBytes = opts.minDocBytes ?? 50;
  await page.waitForFunction((min) => {
    const ifr = document.querySelector('[data-testid="artifact-html"]') as HTMLIFrameElement | null;
    if (!ifr) return false;
    const rect = ifr.getBoundingClientRect();
    return (ifr.getAttribute("srcdoc")?.length ?? 0) > min && rect.width > 100 && rect.height > 100;
  }, minDocBytes, { timeout: 10_000, polling: 100 });
  await page.waitForTimeout(opts.settleMs ?? 700);
}

test.beforeAll(async () => {
  for (const vp of [MOBILE, TABLET, DESKTOP, { name: "ipad-landscape" }]) {
    await fs.rm(path.join(OUT_ROOT, vp.name), { recursive: true, force: true });
  }
});

for (const vp of [MOBILE, TABLET]) {
  test.describe(`promo @ ${vp.name} (${vp.width}x${vp.height})`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });

    test("01 session list", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: /Drafting the postmortem/ }).first().waitFor();
      await shot(page, vp.name, "01-session-list");
    });

    test("02 conversation timeline", async ({ page }) => {
      await page.goto("/");
      await selectSession(page, /Drafting the postmortem/);
      await shot(page, vp.name, "02-conversation");
    });

    test("03 vega-lite artifact", async ({ page }) => {
      await page.goto("/");
      await selectSession(page, /Latency investigation/);
      await waitForVegaPaint(page);
      await shot(page, vp.name, "03-vega-lite-artifact");
    });

    test("04 html dashboard artifact", async ({ page }) => {
      await page.goto("/");
      await selectSession(page, /Cluster sweep/);
      await waitForHtmlArtifact(page);
      await shot(page, vp.name, "04-html-artifact");
    });

    test("05 cron-spawned session", async ({ page }) => {
      await page.goto("/");
      await selectSession(page, /cron: dependabot/);
      await shot(page, vp.name, "05-cron-session");
    });

    test("06 cron jobs admin", async ({ page }) => {
      await page.goto("/");
      const cron = page.getByRole("link", { name: "Schedule", exact: true });
      if (await cron.isVisible().catch(() => false)) {
        await cron.click();
        await page.waitForTimeout(400);
        await shot(page, vp.name, "06-cron-admin");
      }
    });

    test("07 d3 force-graph artifact", async ({ page }) => {
      await page.goto("/");
      await selectSession(page, /Module map/);
      // Bigger HTML payload than the dashboard tile + needs CDN d3 to load and
      // ~220 simulation ticks to settle, so give it longer to paint.
      await waitForHtmlArtifact(page, { minDocBytes: 1500, settleMs: 1500 });
      await shot(page, vp.name, "07-d3-graph-artifact");
    });
  });
}

// Dedicated iPad-landscape capture for the markdown artifact — the markdown
// pitch reads much better with the extra horizontal real estate than it does
// on a phone.
const IPAD_LANDSCAPE = { name: "ipad-landscape", width: 1024, height: 768 };
test.describe(`promo @ ${IPAD_LANDSCAPE.name} (${IPAD_LANDSCAPE.width}x${IPAD_LANDSCAPE.height})`, () => {
  test.use({
    viewport: { width: IPAD_LANDSCAPE.width, height: IPAD_LANDSCAPE.height },
    hasTouch: true,
    isMobile: false,
    deviceScaleFactor: 2,
  });

  test("08 markdown artifact", async ({ page }) => {
    await page.goto("/");
    await selectSession(page, /Why pi-crust/);
    await page.locator('[data-testid="artifact-markdown"]').first().waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(300);
    await shot(page, IPAD_LANDSCAPE.name, "08-markdown-artifact");
  });
});

test.describe(`promo @ ${DESKTOP.name} (${DESKTOP.width}x${DESKTOP.height})`, () => {
  test.use({
    viewport: { width: DESKTOP.width, height: DESKTOP.height },
    deviceScaleFactor: 2,
  });

  test("01 desktop overview with vega-lite", async ({ page }) => {
    await page.goto("/");
    await selectSession(page, /Latency investigation/);
    await waitForVegaPaint(page);
    await shot(page, DESKTOP.name, "01-overview-vega-lite");
  });

  test("02 desktop overview with html dashboard", async ({ page }) => {
    await page.goto("/");
    await selectSession(page, /Cluster sweep/);
    await waitForHtmlArtifact(page);
    await shot(page, DESKTOP.name, "02-overview-html");
  });

  test("03 desktop cron admin", async ({ page }) => {
    await page.goto("/");
    const cron = page.getByRole("link", { name: "Schedule", exact: true });
    if (await cron.isVisible().catch(() => false)) {
      await cron.click();
      await page.waitForTimeout(400);
      await shot(page, DESKTOP.name, "03-cron-admin");
    }
  });

  test("04 desktop d3 force-graph artifact", async ({ page }) => {
    await page.goto("/");
    await selectSession(page, /Module map/);
    await waitForHtmlArtifact(page, { minDocBytes: 1500, settleMs: 1500 });
    await shot(page, DESKTOP.name, "04-d3-graph-artifact");
  });
});
