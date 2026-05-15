import { execSync } from "node:child_process";

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
  const explicit = options.override ?? options.env?.PI_REMOTE_GIT_SHA;
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
