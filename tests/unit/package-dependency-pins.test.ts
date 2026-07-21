import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("published runtime dependency pins", () => {
  it("pins the Pi SDK packages to the tested export-compatible release", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    // The npx smoke suite installs the packed tarball in a fresh dependency
    // graph. A caret range resolved 0.80.10, which removed AuthStorage even
    // though pi-crust imports it at runtime. Keep runtime resolution aligned
    // with the lockfile and the version tested by CI.
    expect(packageJson.dependencies?.["@earendil-works/pi-coding-agent"]).toBe("0.80.6");
    expect(packageJson.dependencies?.["@earendil-works/pi-ai"]).toBe("0.80.6");
  });
});
