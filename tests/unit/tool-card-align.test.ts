import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// User feedback: tool / thought cards looked indented because their summary
// row had `padding: 4px 6px;` while the surrounding `.message-card` body
// text sits flush at the card's left edge. The fix is to drop the 6 px of
// horizontal padding so the row's icon/text starts at the same x as the
// assistant's prose. Hover hit-area still works because the row keeps full
// width inside the message bubble.
//
// Asserted at the CSS source level because jsdom doesn't load real CSS,
// so computed-style checks on rendered components wouldn't see the rule.

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.resolve(here, "../../src/web/components/message-timeline.css");
const css = fs.readFileSync(CSS_PATH, "utf8");

function extractRule(selector: string): string {
  // Match the selector followed (with optional commas / whitespace) by a `{...}` block.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m");
  const match = css.match(pattern);
  if (!match) throw new Error(`Could not find CSS rule for selector ${selector}`);
  return match[1]!.trim();
}

describe("tool-card / thinking-card row alignment", () => {
  it("the tool-card summary row sits flush with the surrounding message text (no left indent)", () => {
    const rule = extractRule(".tool-card summary");
    // Either: explicit `padding-left: 0` OR shorthand `padding: <y> 0` (we
    // accept any vertical value).
    expect(rule).toMatch(/padding\s*:\s*\S+\s+0(?:\s|;|$)|padding-left\s*:\s*0/);
  });

  it("the orphan-tool-result header row sits flush too", () => {
    const rule = extractRule(".orphan-tool-result header");
    expect(rule).toMatch(/padding\s*:\s*\S+\s+0(?:\s|;|$)|padding-left\s*:\s*0/);
  });
});
