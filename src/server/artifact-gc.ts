/**
 * Orphan-artifact garbage collection.
 *
 * Artifact files live at <projectRoot>/.pi/artifacts/<sessionId>/<file>. They
 * are only useful while the corresponding session JSONL still exists. If the
 * user deletes a session through any path (filesystem, /tree, another tool),
 * the artifact directory becomes dead weight. The GC walks the artifacts root
 * and removes per-session subdirectories whose session file is gone AND which
 * are older than the retention threshold.
 *
 * Defaults:
 *   - retentionMs = 7 days. Brand-new sessions whose JSONL was somehow not
 *     yet flushed don't get nuked accidentally during the first run.
 *   - The GC is best-effort: any IO error is logged and skipped, never thrown.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface GcOrphanArtifactsOptions {
  /** Project cwd whose `.pi/artifacts/` subtree should be scanned. */
  readonly projectRoot: string;
  /** Directory containing `<sessionId>.jsonl` files. */
  readonly sessionRoot: string;
  /** Minimum age (ms since last mtime) before a session dir is eligible. Default 7 days. */
  readonly retentionMs?: number;
  /** Override clock (for tests). */
  readonly now?: () => number;
  /** If true, do not delete anything. Returns the would-delete list. */
  readonly dryRun?: boolean;
}

export interface GcOrphanArtifactsResult {
  readonly scanned: number;
  readonly removed: readonly string[];
  readonly skipped: readonly { sessionId: string; reason: string }[];
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function gcOrphanArtifacts(
  options: GcOrphanArtifactsOptions,
): Promise<GcOrphanArtifactsResult> {
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const now = options.now?.() ?? Date.now();
  const artifactsRoot = path.join(options.projectRoot, ".pi", "artifacts");

  let entries: string[];
  try {
    entries = await fs.readdir(artifactsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, removed: [], skipped: [] };
    }
    throw error;
  }

  const removed: string[] = [];
  const skipped: { sessionId: string; reason: string }[] = [];

  for (const sessionId of entries) {
    const dir = path.join(artifactsRoot, sessionId);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      skipped.push({ sessionId, reason: "stat-failed" });
      continue;
    }
    if (!stat.isDirectory()) {
      skipped.push({ sessionId, reason: "not-directory" });
      continue;
    }
    const sessionFile = path.join(options.sessionRoot, `${sessionId}.jsonl`);
    const sessionExists = await fileExists(sessionFile);
    if (sessionExists) {
      skipped.push({ sessionId, reason: "session-alive" });
      continue;
    }
    const ageMs = now - stat.mtimeMs;
    if (ageMs < retentionMs) {
      skipped.push({ sessionId, reason: "too-young" });
      continue;
    }
    if (!options.dryRun) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        skipped.push({ sessionId, reason: "rm-failed" });
        continue;
      }
    }
    removed.push(sessionId);
  }

  return { scanned: entries.length, removed, skipped };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
