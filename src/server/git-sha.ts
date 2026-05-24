import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the short git SHA of the repo serving the API.
 *
 *   1. If an explicit override is provided (env or arg), use it. This is the
 *      CI / Docker path — the runner already knows the SHA from
 *      $GITHUB_SHA / a build arg and shouldn't need to shell out.
 *   2. Otherwise run `git rev-parse --short=12 HEAD` in `cwd` and capture it.
 *   3. If that fails (no git, detached working tree, etc.) return "unknown".
 *
 * Pure-ish: the `runner` dependency is injectable so unit tests can avoid
 * shelling out and pin a deterministic output.
 */
export interface ResolveGitShaOptions {
  readonly cwd?: string;
  readonly override?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: GitRunner;
}

export type GitRunner = (args: readonly string[], cwd: string) => string | null;

export function resolveGitSha(options: ResolveGitShaOptions = {}): string {
  const explicit = options.override ?? options.env?.PI_CRUST_GIT_SHA;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim().slice(0, 12);
  }
  const runner = options.runner ?? defaultRunner;
  const cwd = options.cwd ?? process.cwd();
  const out = runner(["rev-parse", "--short=12", "HEAD"], cwd);
  if (!out) return "unknown";
  const trimmed = out.trim();
  return trimmed || "unknown";
}

const defaultRunner: GitRunner = (args, cwd) => {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2_000,
    }).toString();
  } catch {
    return null;
  }
};

/**
 * Returns a getter that resolves the current short git SHA on each call,
 * but only re-shells out when `.git/HEAD` (or the ref file it points at)
 * has actually changed. This means /api/health stays trivially cheap while
 * still reflecting `git pull`s that landed AFTER api startup — fixing the
 * 'I merged a PR but the help dialog shows the old SHA' confusion.
 *
 *   * On the first call, resolves the SHA and remembers (HEAD-mtime,
 *     ref-mtime, value).
 *   * On subsequent calls, stats the watched files; if neither mtime
 *     has changed, returns the cached value without re-shelling out.
 *   * If the stat itself fails (e.g. `.git/HEAD` was momentarily missing
 *     during a git pull, or the runner returns null), returns the last
 *     known good value (graceful degradation).
 */
export interface LiveGitShaOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: GitRunner;
  readonly fsModule?: Pick<typeof fs, "statSync" | "readFileSync">;
}

export function createLiveGitSha(options: LiveGitShaOptions = {}): () => string {
  // If an explicit override is set (CI, Docker), it never changes; just
  // return a constant getter.
  const explicit = options.env?.PI_CRUST_GIT_SHA;
  if (typeof explicit === "string" && explicit.trim()) {
    const value = explicit.trim().slice(0, 12);
    return () => value;
  }
  const cwd = options.cwd ?? process.cwd();
  const fsm = options.fsModule ?? fs;
  const gitDir = path.join(cwd, ".git");
  const resolveOpts: ResolveGitShaOptions = options.runner !== undefined
    ? { cwd, runner: options.runner }
    : { cwd };
  let cached = resolveGitSha(resolveOpts);
  let lastHeadMtimeMs = -1;
  let lastRefMtimeMs = -1;

  const refMtimeForCurrentHead = (): { headMtimeMs: number; refMtimeMs: number } => {
    let headMtimeMs = -1;
    let refMtimeMs = -1;
    try {
      headMtimeMs = fsm.statSync(path.join(gitDir, "HEAD")).mtimeMs;
    } catch { /* not a git checkout, or transiently gone during pull */ }
    try {
      // If HEAD is a symbolic ref like "ref: refs/heads/main", also watch
      // the ref file itself — that's what changes on a fast-forward pull.
      const headRaw = fsm.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (headRaw.startsWith("ref: ")) {
        const refPath = path.join(gitDir, headRaw.slice("ref: ".length));
        try { refMtimeMs = fsm.statSync(refPath).mtimeMs; }
        catch { /* packed-refs case; fall back to HEAD-mtime alone */ }
      }
    } catch { /* ignore */ }
    return { headMtimeMs, refMtimeMs };
  };

  const initial = refMtimeForCurrentHead();
  lastHeadMtimeMs = initial.headMtimeMs;
  lastRefMtimeMs = initial.refMtimeMs;

  return function liveGitSha(): string {
    const { headMtimeMs, refMtimeMs } = refMtimeForCurrentHead();
    if (headMtimeMs === lastHeadMtimeMs && refMtimeMs === lastRefMtimeMs) {
      return cached;
    }
    const next = resolveGitSha(resolveOpts);
    // If the runner returned "unknown" during a transient git operation,
    // keep serving the last known good value rather than flapping.
    if (next !== "unknown") cached = next;
    lastHeadMtimeMs = headMtimeMs;
    lastRefMtimeMs = refMtimeMs;
    return cached;
  };
}
