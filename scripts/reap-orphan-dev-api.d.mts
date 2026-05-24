/**
 * Type declarations for scripts/reap-orphan-dev-api.mjs.
 *
 * The script is plain ESM JavaScript (so it runs without a build step
 * when invoked as a CLI), but tests import its pure-function exports
 * under strict TypeScript checking. This .d.mts pins the types for
 * those exports.
 */

export interface ReapSnapshotEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly cmdline: string;
  readonly etimeMs: number;
}

export interface ReapTarget {
  readonly pid: number;
  readonly ppid: number;
  readonly cmdline: string;
  readonly etimeMs: number;
  readonly reason: string;
}

export interface FindReapTargetsOptions {
  /** PID of the reaper itself; never kill it. */
  readonly selfPid: number;
  /** Minimum process age in ms for the orphan to be considered kill-eligible. Default 60_000. */
  readonly minEtimeMs?: number;
}

export const DEFAULT_MIN_ETIME_MS: number;

export function findReapTargets(
  snapshot: ReadonlyArray<ReapSnapshotEntry>,
  options: FindReapTargetsOptions,
): ReapTarget[];

export function readProcSnapshot(): ReapSnapshotEntry[];
