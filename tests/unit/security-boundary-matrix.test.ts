import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathWithinRoot, PathPolicy } from "../../src/server/security/path-policy.js";

describe("security boundary matrix", () => {
  it.each([
    { root: "/home/coder/project", candidate: "/home/coder/project", allowed: true },
    { root: "/home/coder/project", candidate: "/home/coder/project/file.txt", allowed: true },
    { root: "/home/coder/project", candidate: "/home/coder/project/sub/../file.txt", allowed: true },
    { root: "/home/coder/project", candidate: "/home/coder/project-evil/file.txt", allowed: false },
    { root: "/home/coder/project", candidate: "/home/coder/project/../../etc/passwd", allowed: false },
    { root: "/home/coder/project", candidate: "/home/coder/project/..", allowed: false },
    { root: "/home/coder/project", candidate: "../project-evil/file.txt", allowed: false },
  ])("isPathWithinRoot($candidate, $root) -> $allowed", ({ root, candidate, allowed }) => {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.isAbsolute(candidate) ? candidate : path.resolve("/home/coder/project", candidate);
    expect(isPathWithinRoot(resolvedCandidate, resolvedRoot)).toBe(allowed);
  });

  it("keeps cwd and session-file allow-lists separate", () => {
    const policy = new PathPolicy({
      allowedProjectRoots: ["/tmp/pi/project"],
      allowedSessionRoots: ["/tmp/pi/sessions"],
    });

    expect(policy.assertAllowedCwd("/tmp/pi/project/subdir")).toBe(path.resolve("/tmp/pi/project/subdir"));
    expect(policy.assertAllowedSessionFile("/tmp/pi/sessions/a.jsonl")).toBe(path.resolve("/tmp/pi/sessions/a.jsonl"));
    expect(() => policy.assertAllowedCwd("/tmp/pi/sessions")).toThrow(/outside allowed project roots/i);
    expect(() => policy.assertAllowedSessionFile("/tmp/pi/project/a.jsonl")).toThrow(/outside allowed session roots/i);
  });

});
