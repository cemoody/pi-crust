import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileRevealHtml } from "../../src/presentations/reveal.js";
import { validatePresentationDeck } from "../../src/presentations/schema.js";

const packDir = path.resolve(process.cwd(), "extensions", "presentations", "templates", "builtin");

describe("built-in presentation template pack fixtures", () => {
  it("documents starter layouts and validates example decks", async () => {
    const pack = JSON.parse(await fs.readFile(path.join(packDir, "template-pack.json"), "utf8")) as {
      id: string;
      layouts: string[];
      themes: string[];
      examples: string[];
    };

    expect(pack).toMatchObject({ id: "builtin-presentations", layouts: ["title", "image-bullets", "bullets"], themes: ["light"] });

    for (const layout of pack.layouts) {
      const metadata = JSON.parse(await fs.readFile(path.join(packDir, "layouts", `${layout}.json`), "utf8")) as { id: string; name: string };
      expect(metadata.id).toBe(layout);
      expect(metadata.name).toBeTruthy();
    }

    for (const example of pack.examples) {
      const deck = JSON.parse(await fs.readFile(path.join(packDir, "examples", example), "utf8"));
      expect(validatePresentationDeck(deck)).toEqual({ ok: true, errors: [] });
      const html = compileRevealHtml(deck);
      expect(html).toContain(deck.title);
      expect(html).toContain("Confidential and Proprietary");
    }
  });
});
