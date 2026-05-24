#!/usr/bin/env node
/**
 * reap-orphan-dev-api.mjs \u2014 sweep orphan dev-api.mjs processes.
 *
 * Why this exists
 * ---------------
 * dev-api.mjs is a dev-time restart-loop supervisor for the HTTP API. It
 * watches src/server/** and respawns the API on file change. It has
 * exactly one legitimate parent: an interactive shell or supervisor
 * running `npm run dev:api:loop` (or `prc-loop.sh`, or systemd).
 *
 * When that parent dies (tmux pane closed, test runner SIGKILL'd, etc.)
 * dev-api.mjs gets reparented to PID 1. From that point on, it has no
 * useful function: it keeps respawning HTTP API children that nothing
 * is connected to. Each one chews CPU; observed 98%-of-a-core on the
 * 2026-05-24 dev box from a single orphan that lived 12+ hours.
 *
 * This is the OPPOSITE durability contract from pirpc-supervisor.mjs.
 * Those are per-session and by-design survive API restarts (that's how
 * `kill <api-pid>` doesn't lose your sessions). NEVER touch them here;
 * scripts/reap-supervisors.mjs handles those with a much more careful
 * runtime-dir + live-API-pid filter.
 *
 * What gets killed
 * ----------------
 * A process is reaped iff ALL of:
 *
 *   1. argv contains "scripts/dev-api.mjs" (with a strict boundary so
 *      we don't match dev-api-helper.mjs or dev-api.mjs.bak)
 *   2. PPID === 1                              (truly orphaned)
 *   3. etimeMs >= MIN_ETIME_MS                 (default 60s; not a
 *                                               legit startup mid-fork)
 *   4. pid !== ourselves
 *
 * Env vars
 * --------
 *   PI_REAP_ORPHAN_DEV_API_MIN_ETIME_MS  min process age in ms (default 60_000)
 *   PI_REAP_ORPHAN_DEV_API_DRY_RUN       "1" \u2192 log targets, don't kill
 *   PI_REAP_ORPHAN_DEV_API_GRACE_MS      ms between SIGTERM and SIGKILL (default 2000)
 *
 * Logs (JSON-lines, grep-friendly):
 *   { event: "orphan_reaper.kill",        pid, ppid, argv, etimeMs, ts }
 *   { event: "orphan_reaper.would_kill",  pid, ppid, argv, etimeMs, ts }   (dry-run)
 *   { event: "orphan_reaper.summary",     scanned, killed, dryRun, ts }
 *
 * Suggested install
 * -----------------
 *   systemd-run --user --unit=pi-orphan-reaper.timer --on-calendar='*:0/1' \
 *     node /path/to/scripts/reap-orphan-dev-api.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure logic: findReapTargets()
// ---------------------------------------------------------------------------

/**
 * One process entry from a /proc snapshot.
 * @typedef {{ pid: number, ppid: number, cmdline: string, etimeMs: number }} ReapSnapshotEntry
 */

/**
 * Argv matcher. Requires "scripts/dev-api.mjs" as a complete filename
 * (preceded by / or whitespace at the start, and followed by whitespace
 * or end-of-string). Rejects "scripts/dev-api-helper.mjs" and
 * "scripts/dev-api.mjs.bak".
 */
const ARGV_PATTERN = /(^|[\s/])scripts\/dev-api\.mjs(\s|$)/;

export const DEFAULT_MIN_ETIME_MS = 60_000;
const DEFAULT_GRACE_MS = 2_000;

/**
 * Pure classifier. Given a /proc snapshot + config, returns the list of
 * pids that should be reaped, in ascending-pid order for stable logs.
 *
 * @param {ReadonlyArray<ReapSnapshotEntry>} snapshot
 * @param {{ selfPid: number, minEtimeMs?: number }} opts
 * @returns {Array<{ pid: number, ppid: number, cmdline: string, etimeMs: number, reason: string }>}
 */
export function findReapTargets(snapshot, opts) {
  const minEtimeMs = opts.minEtimeMs ?? DEFAULT_MIN_ETIME_MS;
  const out = [];
  for (const entry of snapshot) {
    if (entry.pid === opts.selfPid) continue;            // (4) never suicide
    if (!ARGV_PATTERN.test(entry.cmdline)) continue;     // (1) right process class
    if (entry.ppid !== 1) continue;                      // (2) truly orphan
    if (entry.etimeMs < minEtimeMs) continue;            // (3) old enough
    out.push({
      pid: entry.pid,
      ppid: entry.ppid,
      cmdline: entry.cmdline,
      etimeMs: entry.etimeMs,
      reason: "orphan dev-api.mjs (PPID=1, no live parent)",
    });
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

// ---------------------------------------------------------------------------
// /proc scanner (Linux). Returns ReapSnapshotEntry[] for everything alive.
// ---------------------------------------------------------------------------

/**
 * Read a /proc snapshot at the moment of the call. Linux-only.
 * Non-Linux (CI on macOS / Windows / containers without /proc) returns [].
 *
 * @returns {ReapSnapshotEntry[]}
 */
export function readProcSnapshot() {
  if (process.platform !== "linux") return [];
  const now = Date.now();
  const bootMsSinceEpoch = readBootTimeMs();
  /** @type {ReapSnapshotEntry[]} */
  const entries = [];
  let names;
  try { names = fs.readdirSync("/proc"); } catch { return entries; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let cmdline = "";
    let ppid = 0;
    let startTimeJiffies = 0;
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch { continue; }
    if (!cmdline) continue; // zombie / kthread / race with exit
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Format: pid (comm) state ppid ... starttime is field 22 (1-indexed),
      // i.e. index 19 of the post-`)` split. Anchor on the LAST ')' to
      // tolerate process names that contain parens.
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const after = stat.slice(close + 2).split(" ");
      ppid = Number(after[1]);
      startTimeJiffies = Number(after[19]);
    } catch { continue; }
    const etimeMs = computeEtimeMs(now, bootMsSinceEpoch, startTimeJiffies);
    entries.push({ pid, ppid, cmdline, etimeMs });
  }
  return entries;
}

function computeEtimeMs(nowMs, bootMs, startTimeJiffies) {
  // The kernel reports starttime in clock ticks (USER_HZ) since boot. On
  // Linux that's normally 100 ticks/sec, but we read it from sysconf when
  // available to be safe.
  if (!Number.isFinite(startTimeJiffies) || !bootMs) return 0;
  const ticksPerSec = readHz();
  const startMs = bootMs + (startTimeJiffies / ticksPerSec) * 1000;
  return Math.max(0, nowMs - startMs);
}

let cachedHz = 0;
function readHz() {
  if (cachedHz > 0) return cachedHz;
  // No sysconf in Node; fall back to the near-universal default. The race
  // window we care about is "is the process > 60 seconds old", well below
  // the precision required to need exact USER_HZ.
  cachedHz = 100;
  return cachedHz;
}

let cachedBootMs = 0;
function readBootTimeMs() {
  if (cachedBootMs > 0) return cachedBootMs;
  try {
    const stat = fs.readFileSync("/proc/stat", "utf8");
    const m = stat.match(/^btime\s+(\d+)$/m);
    if (m && m[1]) cachedBootMs = Number(m[1]) * 1000;
  } catch { /* ignore */ }
  return cachedBootMs;
}

// ---------------------------------------------------------------------------
// Reap action: SIGTERM with grace \u2192 SIGKILL.
// ---------------------------------------------------------------------------

/** @returns {Promise<{ scanned: number, killed: number, dryRun: boolean }>} */
async function main() {
  const minEtimeMs = Number(process.env.PI_REAP_ORPHAN_DEV_API_MIN_ETIME_MS ?? DEFAULT_MIN_ETIME_MS);
  const graceMs = Number(process.env.PI_REAP_ORPHAN_DEV_API_GRACE_MS ?? DEFAULT_GRACE_MS);
  const dryRun = process.env.PI_REAP_ORPHAN_DEV_API_DRY_RUN === "1";

  // Test hook: when PI_REAP_ORPHAN_DEV_API_SNAPSHOT_FILE points to a JSON file,
  // load the snapshot from there instead of /proc. This is used by integration
  // tests that run inside a subreaper (vitest worker) where forcing PPID=1 on
  // a real process isn't possible. The file is opt-in via env; production
  // never sets it.
  const snapshotFile = process.env.PI_REAP_ORPHAN_DEV_API_SNAPSHOT_FILE;
  const snapshot = snapshotFile
    ? JSON.parse(fs.readFileSync(snapshotFile, "utf8"))
    : readProcSnapshot();
  const targets = findReapTargets(snapshot, { selfPid: process.pid, minEtimeMs });

  for (const t of targets) {
    const event = dryRun ? "orphan_reaper.would_kill" : "orphan_reaper.kill";
    log({ event, pid: t.pid, ppid: t.ppid, etimeMs: t.etimeMs, argv: t.cmdline.slice(0, 240), reason: t.reason });
    if (dryRun) continue;
    try { process.kill(t.pid, "SIGTERM"); } catch { /* may have already died between snapshot and now */ }
  }

  if (!dryRun && targets.length > 0) {
    await new Promise((r) => setTimeout(r, graceMs));
    for (const t of targets) {
      try {
        // kill(0) tells us if it's still alive; if so, escalate.
        process.kill(t.pid, 0);
        log({ event: "orphan_reaper.escalate_sigkill", pid: t.pid });
        try { process.kill(t.pid, "SIGKILL"); } catch { /* already gone */ }
      } catch { /* already gone, ESRCH */ }
    }
  }

  log({ event: "orphan_reaper.summary", scanned: snapshot.length, killed: dryRun ? 0 : targets.length, would_kill: dryRun ? targets.length : 0, dryRun });
  return { scanned: snapshot.length, killed: dryRun ? 0 : targets.length, dryRun };
}

function log(payload) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...payload }));
}

// Run as CLI only when invoked directly (not when imported by tests).
const isCli = (() => {
  if (!process.argv[1]) return false;
  // Use fileURLToPath() so the comparison matches what Node passes in argv[1]
  // (handles URL-encoded chars; the previous slice('file://'.length) approach
  // could break when paths contained spaces or unicode).
  try { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isCli) {
  main().then(
    () => process.exit(0),
    (err) => { console.error(JSON.stringify({ event: "orphan_reaper.error", error: String(err) })); process.exit(1); },
  );
}
