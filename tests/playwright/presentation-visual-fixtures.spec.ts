import { expect, test } from "@playwright/test";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import type { PresentationDeck } from "../../src/presentations/schema.js";

const genericFixture: PresentationDeck = {
  title: "Presentation Template Fixture",
  theme: "light",
  slides: [
    { template: "title", title: "Primary Title", subtitle: "Secondary Title", body: "Executive summary text for objectives, strategies, outcomes, and next steps." },
    { template: "quote", quote: "Technology shapes how we think and work; its real power emerges when human creativity guides machines.", attribution: "Alan Turing" },
    { template: "metric", title: "A shorter title made large for emphasis", bullets: ["This is a bullet point meant to explain something succinctly and clearly"], stats: [{ value: "$25B", label: "supporting stat in the presentation" }] },
    { template: "columns", title: "Team overview", subtitle: "A team of proven experts and operators", columns: [
      { title: "First Name Last Name", body: "Titles", bullets: ["Experience highlights"] },
      { title: "First Name Last Name", body: "Titles", bullets: ["Experience highlights"] },
      { title: "First Name Last Name", body: "Titles", bullets: ["Experience highlights"] },
      { title: "First Name Last Name", body: "Titles", bullets: ["Experience highlights"] },
    ] },
  ],
};

test("captures generic presentation template visual fixtures", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(compileRevealHtml(genericFixture));

  await expect(page.locator(".slide.active .title-block, .slide.active h1")).toContainText("Primary Title");
  await page.screenshot({ path: "test-results/presentation-template-title.png" });

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide.active blockquote")).toContainText("Technology shapes");
  await page.screenshot({ path: "test-results/presentation-template-quote.png" });

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide.active .stat strong")).toContainText("$25B");
  await page.screenshot({ path: "test-results/presentation-template-metric.png" });

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide.active .column-card")).toHaveCount(4);
  await page.screenshot({ path: "test-results/presentation-template-columns.png" });
});
