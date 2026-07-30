import path from "node:path";
import { describe, expect, it } from "vitest";

import { isPathWithinRoot } from "../../src/server/security/path-policy.js";

describe("isPathWithinRoot", () => {
  const root = path.join(path.sep, "workspace", "project");

  it("accepts the root itself and nested paths", () => {
    expect(isPathWithinRoot(root, root)).toBe(true);
    expect(isPathWithinRoot(path.join(root, "assets", "chart.png"), root)).toBe(true);
  });

  it("rejects ancestor paths and sibling directories with the same prefix", () => {
    expect(isPathWithinRoot(path.dirname(root), root)).toBe(false);
    expect(isPathWithinRoot(`${root}-backup/chart.png`, root)).toBe(false);
  });
});
