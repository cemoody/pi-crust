import { describe, expect, it, vi } from "vitest";
import { resolveGitSha } from "../../src/server/git-sha.js";

describe("resolveGitSha", () => {
  it("honors PI_REMOTE_GIT_SHA from the env when set", () => {
    expect(resolveGitSha({ env: { PI_REMOTE_GIT_SHA: "deadbeefcafe1234" }, runner: () => null })).toBe("deadbeefcafe");
  });

  it("honors an explicit override above env", () => {
    expect(resolveGitSha({ env: { PI_REMOTE_GIT_SHA: "from-env" }, override: "fedcba987654321", runner: () => null })).toBe("fedcba987654");
  });

  it("shells out to git when no override is provided", () => {
    const runner = vi.fn(() => "abc123def456\n");
    expect(resolveGitSha({ runner })).toBe("abc123def456");
    expect(runner).toHaveBeenCalledWith(["rev-parse", "--short=12", "HEAD"], expect.any(String));
  });

  it("returns 'unknown' when git returns null (no repo / failure)", () => {
    expect(resolveGitSha({ runner: () => null })).toBe("unknown");
  });

  it("returns 'unknown' when git returns an empty string", () => {
    expect(resolveGitSha({ runner: () => "" })).toBe("unknown");
  });

  it("ignores whitespace-only env override and falls back to runner", () => {
    const runner = vi.fn(() => "fallback1234");
    expect(resolveGitSha({ env: { PI_REMOTE_GIT_SHA: "   " }, runner })).toBe("fallback1234");
    expect(runner).toHaveBeenCalledOnce();
  });
});
