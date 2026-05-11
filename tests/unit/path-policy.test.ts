import { describe, expect, it } from "vitest";
import path from "node:path";
import { PathPolicy } from "../../src/server/security/path-policy.js";

describe("PathPolicy", () => {
  const projectRoot = path.resolve("/tmp/pi-remote/project");
  const sessionRoot = path.resolve("/tmp/pi-remote/sessions");
  const policy = new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] });

  it("allows imports from project and session roots", () => {
    expect(policy.assertAllowedImportFile(path.join(projectRoot, "session.jsonl"))).toBe(path.join(projectRoot, "session.jsonl"));
    expect(policy.assertAllowedImportFile(path.join(sessionRoot, "session.jsonl"))).toBe(path.join(sessionRoot, "session.jsonl"));
  });

  it("rejects import path traversal outside configured roots", () => {
    expect(() => policy.assertAllowedImportFile("/tmp/pi-remote/other/session.jsonl")).toThrow(/outside allowed roots/);
  });

  it("restricts exports to project or session roots", () => {
    expect(policy.assertAllowedExportFile(path.join(projectRoot, "out.html"))).toBe(path.join(projectRoot, "out.html"));
    expect(() => policy.assertAllowedExportFile("/tmp/out.html")).toThrow(/outside allowed roots/);
  });
});
