import { expect, test } from "@playwright/test";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

const qxoFixture: PresentationDeck = {
  title: "QXO Template Fixture",
  theme: "brainco",
  slides: [
    { template: "title", title: "Primary Title", subtitle: "Secondary Title", body: "Executive summary text for objectives, strategies, outcomes, and next steps." },
    { template: "quote", quote: "Technology shapes how we think and work; its real power emerges when human creativity guides machines.", attribution: "Alan Turing" },
    { template: "metric", title: "A shorter title made large for emphasis", bullets: ["This is a bullet point meant to explain something succinctly and clearly"], stats: [{ value: "$25B", label: "supporting stat in the presentation" }] },
    { template: "columns", title: "Meet Brain Co.", subtitle: "A team of proven tech experts and entrepreneurs", columns: [
      { title: "First Name Last Name", body: "Titles", bullets: ["Experience highlights"] },
      { title: "First Name Last Name", body: "Titles", bullets: ["Experience highlights"] },
      { title: "First Name Last Name", body: "Titles", bullets: ["Experience highlights"] },
      { title: "First Name Last Name", body: "Titles", bullets: ["Experience highlights"] },
    ] },
  ],
};

test("captures QXO-style presentation template visual fixtures", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(compileRevealHtml(qxoFixture));

  await expect(page.locator(".slide.active h1")).toContainText("Primary Title");
  await page.screenshot({ path: "test-results/qxo-template-title.png" });

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide.active blockquote")).toContainText("Technology shapes");
  await page.screenshot({ path: "test-results/qxo-template-quote.png" });

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide.active .stat strong")).toContainText("$25B");
  await page.screenshot({ path: "test-results/qxo-template-metric.png" });

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide.active .column-card")).toHaveCount(4);
  await page.screenshot({ path: "test-results/qxo-template-columns.png" });
});
