/**
 * Unit tests for the orphan-dev-api reaper's pure classifier.
 *
 * The reaper script exports a pure findReapTargets() function that takes
 * a snapshot of /proc-like entries + a config and returns the list of
 * pids that satisfy every kill predicate. We test the pure function
 * directly so we don't need a real /proc to enumerate.
 *
 * Why dev-api.mjs specifically (and NOT pirpc-supervisor.mjs):
 *
 *   Per-session pirpc-supervisors are BY DESIGN long-lived; they're the
 *   thing that lets `kill <api-pid>` not lose your session. They survive
 *   API restarts, code changes, the whole point of the architecture.
 *
 *   dev-api.mjs is the OPPOSITE. It's a dev-time restart-loop supervisor
 *   for the API process. Once orphaned (PPID=1, parent shell/tmux pane
 *   gone), it has no useful function: it keeps respawning HTTP API
 *   children that nothing is connected to. Three production outages on
 *   2026-05-24 traced to orphaned dev-api.mjs processes from non-canonical
 *   worktrees pegging CPU. This reaper kills exactly that failure shape.
 *
 * Predicates the classifier must enforce (ALL of these):
 *
 *   1. argv contains "scripts/dev-api.mjs"           \u2014 right process class
 *   2. PPID === 1                                    \u2014 truly orphaned
 *   3. etimeMs >= MIN_ETIME_MS                       \u2014 not a freshly-started
 *                                                       legit dev-api whose
 *                                                       parent is still in
 *                                                       the middle of fork()
 *   4. pid !== process.pid (the reaper itself)       \u2014 obvious; never suicide
 */

import { describe, expect, it } from "vitest";
import {
  findReapTargets,
  DEFAULT_MIN_ETIME_MS,
  type ReapSnapshotEntry,
} from "../../scripts/reap-orphan-dev-api.mjs";

const NODE = process.execPath;

function entry(
  pid: number,
  partial: Partial<Omit<ReapSnapshotEntry, "pid">>,
): ReapSnapshotEntry {
  return {
    pid,
    ppid: partial.ppid ?? 1,
    cmdline: partial.cmdline ?? `${NODE} /home/coder/code/x/scripts/dev-api.mjs -- npm run dev:api`,
    etimeMs: partial.etimeMs ?? DEFAULT_MIN_ETIME_MS + 1_000,
  };
}

describe("findReapTargets", () => {
  it("returns an empty array on an empty snapshot", () => {
    expect(findReapTargets([], { selfPid: 1234 })).toEqual([]);
  });

  it("returns an empty array when nothing matches the argv pattern", () => {
    const snapshot: ReapSnapshotEntry[] = [
      entry(100, { cmdline: "/usr/bin/node app.js" }),
      entry(101, { cmdline: "/usr/bin/python3 -m http.server" }),
      entry(102, { cmdline: "/usr/bin/node /home/coder/code/x/scripts/pirpc-supervisor.mjs --command pi" }),
    ];
    expect(findReapTargets(snapshot, { selfPid: 1234 })).toEqual([]);
  });

  it("flags a clear-cut orphan dev-api.mjs (PPID=1, old enough, right argv)", () => {
    const snapshot = [entry(500, {})];
    const out = findReapTargets(snapshot, { selfPid: 1234 });
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(500);
    expect(out[0]?.reason).toMatch(/orphan/i);
  });

  it("does NOT flag a dev-api.mjs that still has a live parent (PPID != 1)", () => {
    // Real-world scenario: the user's tmux pane is alive and running
    // `npm run dev:api:loop`. We MUST NOT kill the dev-api.mjs in that
    // tree.
    const snapshot = [entry(500, { ppid: 8888 })];
    expect(findReapTargets(snapshot, { selfPid: 1234 })).toEqual([]);
  });

  it("does NOT flag a freshly-started dev-api.mjs even if it's already PPID=1", () => {
    // Race-condition guard: a legitimate `npm run dev:api:loop` startup
    // can briefly have its dev-api.mjs at PPID=1 between fork() and the
    // npm wrapper claiming it. We require a minimum age so we don't
    // race-kill a legitimate startup.
    const snapshot = [entry(500, { etimeMs: 5_000 })];
    expect(findReapTargets(snapshot, { selfPid: 1234 })).toEqual([]);
  });

  it("uses the configured minEtimeMs override (allows tests to be fast)", () => {
    const snapshot = [entry(500, { etimeMs: 250 })];
    const out = findReapTargets(snapshot, { selfPid: 1234, minEtimeMs: 100 });
    expect(out).toHaveLength(1);
    expect(out[0]?.pid).toBe(500);
  });

  it("never flags the reaper's own pid (selfPid)", () => {
    const snapshot = [entry(500, {})];
    expect(findReapTargets(snapshot, { selfPid: 500 })).toEqual([]);
  });

  it("only matches argv that actually contains 'scripts/dev-api.mjs' (not anything similar)", () => {
    // A real-world false-positive trap: someone runs `node scripts/dev-api-helper.mjs`
    // \u2014 the substring is a prefix but it's a different file. Conversely,
    // `scripts/dev-api.mjs.bak` would match a naive substring; tighten the
    // regex to require either end-of-string or a word boundary after .mjs.
    const snapshot: ReapSnapshotEntry[] = [
      entry(100, { cmdline: `${NODE} scripts/dev-api-helper.mjs --foo` }),
      entry(101, { cmdline: `${NODE} scripts/dev-api.mjs.bak --foo` }),
      entry(102, { cmdline: `${NODE} scripts/dev-api.mjs -- npm run dev:api` }), // matches
      entry(103, { cmdline: `${NODE} /abs/path/scripts/dev-api.mjs --` }),       // matches
    ];
    const out = findReapTargets(snapshot, { selfPid: 1 }).map((t: { pid: number }) => t.pid).sort();
    expect(out).toEqual([102, 103]);
  });

  it("DOES NOT flag pirpc-supervisor.mjs (different reaper handles those)", () => {
    // pirpc-supervisor.mjs is per-session and BY-DESIGN survives API
    // restarts and parent-shell death. This reaper must scrupulously
    // leave it alone; scripts/reap-supervisors.mjs handles those with
    // a much more careful runtime-dir + live-API-pid filter.
    const snapshot: ReapSnapshotEntry[] = [
      entry(100, { cmdline: `${NODE} /home/coder/code/x/scripts/pirpc-supervisor.mjs --command /usr/bin/pi` }),
      entry(101, { cmdline: `${NODE} /home/coder/code/x/scripts/dev-api.mjs -- npm run dev:api` }),
    ];
    const out = findReapTargets(snapshot, { selfPid: 1 }).map((t: { pid: number }) => t.pid);
    expect(out).toEqual([101]);
  });

  it("handles many entries efficiently and returns them in pid order for stable logs", () => {
    // Real /proc on a busy dev box has 200\u2013500 entries. The classifier is
    // O(n) but we pin the determinism of its output ordering so tests
    // (and operators reading the log) can rely on it.
    const snapshot: ReapSnapshotEntry[] = [];
    for (let i = 0; i < 500; i++) {
      // Most are not-orphan, with a sprinkling of orphan dev-api.mjs ones.
      const isOrphan = i % 50 === 0;
      snapshot.push(entry(1000 + i, {
        cmdline: isOrphan
          ? `${NODE} /home/coder/code/foo-${i}/scripts/dev-api.mjs -- npm run dev:api`
          : "/usr/bin/python3 -m http.server",
        ppid: isOrphan ? 1 : 12345,
      }));
    }
    const out = findReapTargets(snapshot, { selfPid: 1 }).map((t: { pid: number }) => t.pid);
    expect(out.length).toBe(10);
    // Strictly ascending pid order.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThan(out[i - 1]!);
    }
  });
});
