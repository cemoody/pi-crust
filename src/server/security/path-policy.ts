import path from "node:path";

export interface PathPolicyOptions {
  readonly allowedProjectRoots: readonly string[];
  readonly allowedSessionRoots: readonly string[];
}

export class PathPolicy {
  private readonly allowedProjectRoots: readonly string[];
  private readonly allowedSessionRoots: readonly string[];

  constructor(options: PathPolicyOptions) {
    this.allowedProjectRoots = options.allowedProjectRoots.map(normalizeDir);
    this.allowedSessionRoots = options.allowedSessionRoots.map(normalizeDir);
  }

  assertAllowedCwd(cwd: string): string {
    const resolved = normalizeDir(cwd);
    if (!this.allowedProjectRoots.some((root) => isPathWithinRoot(resolved, root))) {
      throw new Error(`Cwd is outside allowed project roots: ${cwd}`);
    }
    return resolved;
  }

  assertAllowedSessionFile(sessionFile: string): string {
    const resolved = path.resolve(sessionFile);
    if (!this.allowedSessionRoots.some((root) => isPathWithinRoot(resolved, root))) {
      throw new Error(`Session file is outside allowed session roots: ${sessionFile}`);
    }
    return resolved;
  }
}

function normalizeDir(value: string): string {
  return path.resolve(value);
}

/**
 * True iff `candidate` resolves to a path inside (or equal to) `root`.
 *
 * Both arguments are run through `path.resolve()` first, so callers may pass
 * relative paths. The implementation uses `path.relative()` so it's correct
 * on case-insensitive filesystems where a naive prefix check would falsely
 * accept e.g. `/home/coderdocs` as inside `/home/coder`.
 *
 * Exported because two server modules (path-policy itself and the
 * artifact-resolution code in http-api-server.ts) need the same check;
 * keep them on one implementation to avoid drift.
 */
export function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
