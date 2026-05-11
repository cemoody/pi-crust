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
    if (!this.allowedProjectRoots.some((root) => isWithinOrEqual(resolved, root))) {
      throw new Error(`Cwd is outside allowed project roots: ${cwd}`);
    }
    return resolved;
  }

  assertAllowedSessionFile(sessionFile: string): string {
    const resolved = path.resolve(sessionFile);
    if (!this.allowedSessionRoots.some((root) => isWithinOrEqual(resolved, root))) {
      throw new Error(`Session file is outside allowed session roots: ${sessionFile}`);
    }
    return resolved;
  }

  assertAllowedImportFile(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (![...this.allowedProjectRoots, ...this.allowedSessionRoots].some((root) => isWithinOrEqual(resolved, root))) {
      throw new Error(`Import file is outside allowed roots: ${filePath}`);
    }
    return resolved;
  }

  assertAllowedExportFile(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (![...this.allowedProjectRoots, ...this.allowedSessionRoots].some((root) => isWithinOrEqual(resolved, root))) {
      throw new Error(`Export file is outside allowed roots: ${filePath}`);
    }
    return resolved;
  }
}

function normalizeDir(value: string): string {
  return path.resolve(value);
}

function isWithinOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
