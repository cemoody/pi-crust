import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";

const CSS_PATH = "src/web/components/session-dashboard.css";

describe("app branding CSS", () => {
  it("scales app and settings icon images without distorting aspect ratio", async () => {
    const css = await fs.readFile(CSS_PATH, "utf8");
    expect(css).toMatch(/\.app-brand-icon\s*\{[^}]*object-fit:\s*contain;/s);
    expect(css).toMatch(/\.branding-icon-preview\s*\{[^}]*object-fit:\s*contain;/s);
  });
});
