import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows/mobile-webkit-nightly.yml"), "utf8");

describe("mobile WebKit workflow", () => {
  it("resolves the Playwright version with shell-valid quoting before caching browsers", () => {
    const match = workflow.match(/- name: resolve playwright version\n[\s\S]*?(?=\n      - name: cache playwright browsers)/);
    expect(match?.[0]).toContain('version="$(node -p "require(\'@playwright/test/package.json\').version")"');
    expect(match?.[0]).toContain('echo "version=$version" >> "$GITHUB_OUTPUT"');
    expect(match?.[0]).not.toContain('node -p \\"require(');
  });
});
