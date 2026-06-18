/**
 * End-to-end demo of the file-path presentation flow:
 *   1. Write the full deck spec to a JSON file on disk.
 *   2. Invoke the show_presentation tool with ONLY { path } — no inline deck.
 *   3. Take the resulting deck artifact and compile it to standalone HTML.
 *   4. Screenshot the rendered deck with Chromium.
 *
 * Run: node_modules/.bin/tsx scripts/demo-presentation-specfile.mts
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import piRemoteArtifacts from "../src/server/pi/extensions/pi-crust-artifacts.js";
import { compileStandalonePresentationHtml } from "../src/presentations/standalone.js";

const OUT_DIR = path.resolve("demo-out");
await fs.mkdir(OUT_DIR, { recursive: true });

// 1. Write the full deck spec to a JSON file.
const specPath = path.join(OUT_DIR, "deck.spec.json");
const spec = {
  title: "Q3 Signal Brief",
  subtitle: "Read entirely from a JSON spec file — zero inline JSON in the tool call",
  theme: "dark",
  client: "Pi Remote Control",
  slides: [
    { template: "title", title: "Q3 Signal Brief", subtitle: "File-backed deck spec demo", eyebrow: "PI CRUST" },
    {
      title: "Why a file path?",
      bullets: [
        { text: "Tool calls stay tiny", detail: "No 50kB of JSON inline in the conversation" },
        { text: "Specs are reusable", detail: "Edit deck.spec.json and re-run" },
        "Large decks no longer bloat the transcript",
      ],
    },
    {
      template: "stats",
      title: "Impact",
      stats: [
        { value: "~50kB", label: "JSON removed from each call" },
        { value: "1", label: "param: path" },
        { value: "100%", label: "spec lives on disk" },
      ],
    },
    {
      template: "quote",
      quote: "The presentation spec is a JSON file, not inline.",
      attribution: "show_presentation, v2",
    },
  ],
};
await fs.writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");
console.log(`[1] wrote spec file: ${specPath} (${(await fs.stat(specPath)).size} bytes)`);

// 2. Invoke the tool with ONLY { path }.
type Tool = { name: string; execute(id: string, p: Record<string, unknown>): Promise<unknown> };
const tools: Tool[] = [];
piRemoteArtifacts({ registerTool: (t: Tool) => tools.push(t) } as never);
const tool = tools.find((t) => t.name === "show_presentation")!;
const result = (await tool.execute("demo-call", { path: specPath })) as {
  content: Array<{ text: string }>;
  details: { piRemoteControlArtifact: { data: unknown } };
};
console.log(`[2] tool output: ${result.content[0].text}`);
const deck = result.details.piRemoteControlArtifact.data as Parameters<typeof compileStandalonePresentationHtml>[0];

// 3. Compile to standalone HTML.
const html = await compileStandalonePresentationHtml(deck);
const htmlPath = path.join(OUT_DIR, "deck.html");
await fs.writeFile(htmlPath, html, "utf8");
console.log(`[3] compiled HTML: ${htmlPath} (${html.length} bytes)`);

// 4. Screenshot the first two slides.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`file://${htmlPath}`);
await page.waitForTimeout(1200);
const shot1 = path.join(OUT_DIR, "slide-1.png");
await page.screenshot({ path: shot1 });
console.log(`[4] screenshot: ${shot1}`);
// advance to next slide
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(800);
const shot2 = path.join(OUT_DIR, "slide-2.png");
await page.screenshot({ path: shot2 });
console.log(`[4] screenshot: ${shot2}`);
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(800);
const shot3 = path.join(OUT_DIR, "slide-3.png");
await page.screenshot({ path: shot3 });
console.log(`[4] screenshot: ${shot3}`);
await browser.close();
console.log("DONE");
