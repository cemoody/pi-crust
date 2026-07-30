import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("release automation configuration", () => {
  it("groups Pi's runtime packages in daily Dependabot updates", () => {
    const config = read(".github/dependabot.yml");
    expect(config).toContain("package-ecosystem: npm");
    expect(config).toContain("interval: daily");
    expect(config).toContain('"@earendil-works/pi-*"');
  });

  it("enables native auto-merge only for Dependabot Pi upgrades", () => {
    const workflow = read(".github/workflows/auto-merge-dependencies.yml");
    expect(workflow).toContain("pull_request_target");
    expect(workflow).toContain("dependabot[bot]");
    expect(workflow).toContain("gh pr merge");
    expect(workflow).toMatch(/pi-ai\|pi-coding-agent/);
  });

  it("publishes from main with npm trusted publishing permissions", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npx semantic-release");
    expect(workflow).toContain("fetch-depth: 0");
  });

  it("turns dependency commits into patch releases", () => {
    const config = JSON.parse(read(".releaserc.json")) as { plugins: unknown[] };
    expect(JSON.stringify(config)).toContain('"scope":"deps","release":"patch"');
  });
});
