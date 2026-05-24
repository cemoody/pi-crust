import { describe, expect, it, vi } from "vitest";
import { resolveGitSha, createLiveGitSha } from "../../src/server/git-sha.js";

describe("resolveGitSha", () => {
  it("honors PI_CRUST_GIT_SHA from the env when set", () => {
    expect(resolveGitSha({ env: { PI_CRUST_GIT_SHA: "deadbeefcafe1234" }, runner: () => null })).toBe("deadbeefcafe");
  });

  it("honors an explicit override above env", () => {
    expect(resolveGitSha({ env: { PI_CRUST_GIT_SHA: "from-env" }, override: "fedcba987654321", runner: () => null })).toBe("fedcba987654");
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
    expect(resolveGitSha({ env: { PI_CRUST_GIT_SHA: "   " }, runner })).toBe("fallback1234");
    expect(runner).toHaveBeenCalledOnce();
  });
});

describe("createLiveGitSha", () => {
  // Build a fake fs + runner pair so tests are deterministic and don't shell
  // out. State is per-key: tests control HEAD-mtime / ref-mtime explicitly.
  interface FakeState {
    headMs: number;
    refMs: number;
    headContents: string;
  }
  function makeFakeFs(initial: FakeState) {
    const state: FakeState = { ...initial };
    return {
      set(next: Partial<FakeState>) { Object.assign(state, next); },
      module: {
        statSync(p: string) {
          if (p.endsWith("/.git/HEAD")) return { mtimeMs: state.headMs } as ReturnType<typeof import("node:fs").statSync>;
          return { mtimeMs: state.refMs } as ReturnType<typeof import("node:fs").statSync>;
        },
        readFileSync(p: string) {
          if (p.endsWith("/.git/HEAD")) return state.headContents;
          return "";
        },
      } as Pick<typeof import("node:fs"), "statSync" | "readFileSync">,
    };
  }

  it("caches the SHA across calls when .git/HEAD and ref mtime don't change", () => {
    const runner = vi.fn(() => "aaaaaaaaaaaa");
    const fake = makeFakeFs({ headMs: 100, refMs: 200, headContents: "ref: refs/heads/main\n" });
    const get = createLiveGitSha({ runner, fsModule: fake.module, cwd: "/repo" });
    expect(get()).toBe("aaaaaaaaaaaa");
    expect(get()).toBe("aaaaaaaaaaaa");
    expect(get()).toBe("aaaaaaaaaaaa");
    expect(runner).toHaveBeenCalledOnce();
  });

  it("recomputes when .git/HEAD mtime changes (branch switch)", () => {
    const runner = vi.fn();
    runner.mockReturnValueOnce("aaaaaaaaaaaa");
    runner.mockReturnValueOnce("bbbbbbbbbbbb");
    const fake = makeFakeFs({ headMs: 100, refMs: 200, headContents: "ref: refs/heads/main\n" });
    const get = createLiveGitSha({ runner, fsModule: fake.module, cwd: "/repo" });
    expect(get()).toBe("aaaaaaaaaaaa");
    expect(get()).toBe("aaaaaaaaaaaa");
    fake.set({ headMs: 300 }); // simulate branch switch
    expect(get()).toBe("bbbbbbbbbbbb");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("recomputes when the underlying ref mtime changes (fast-forward pull on the same branch)", () => {
    const runner = vi.fn();
    runner.mockReturnValueOnce("aaaaaaaaaaaa");
    runner.mockReturnValueOnce("cccccccccccc");
    const fake = makeFakeFs({ headMs: 100, refMs: 200, headContents: "ref: refs/heads/main\n" });
    const get = createLiveGitSha({ runner, fsModule: fake.module, cwd: "/repo" });
    expect(get()).toBe("aaaaaaaaaaaa");
    fake.set({ refMs: 500 }); // simulate `git pull --ff-only` bumping the ref file
    expect(get()).toBe("cccccccccccc");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known good value when the runner transiently returns 'unknown' mid-pull", () => {
    const runner = vi.fn();
    runner.mockReturnValueOnce("aaaaaaaaaaaa"); // initial
    runner.mockReturnValueOnce("");              // simulates mid-pull failure (= "unknown")
    const fake = makeFakeFs({ headMs: 100, refMs: 200, headContents: "ref: refs/heads/main\n" });
    const get = createLiveGitSha({ runner, fsModule: fake.module, cwd: "/repo" });
    expect(get()).toBe("aaaaaaaaaaaa");
    fake.set({ refMs: 500 }); // ref-mtime changed, BUT runner is about to flake
    // ref mtime changed, runner returned empty ("unknown"); we should NOT
    // flap the displayed SHA to "unknown" — last known good is sticky.
    expect(get()).toBe("aaaaaaaaaaaa");
  });

  it("returns the env override as a constant getter (never reshells)", () => {
    const runner = vi.fn();
    const fake = makeFakeFs({ headMs: 100, refMs: 200, headContents: "ref: refs/heads/main\n" });
    const get = createLiveGitSha({ env: { PI_CRUST_GIT_SHA: "deadbeefcafe1234" }, runner, fsModule: fake.module });
    expect(get()).toBe("deadbeefcafe");
    expect(get()).toBe("deadbeefcafe");
    expect(runner).not.toHaveBeenCalled();
  });
});
