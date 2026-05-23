#!/usr/bin/env node
/**
 * reap-supervisors.mjs — sweep orphan pirpc-supervisor.mjs processes.
 *
 * Why this exists: a single 2026-05-23 audit found 147 orphan supervisor
 * processes consuming ~16 GB combined RSS on the dev box. Every API
 * restart that didn't cleanly re-adopt its existing per-session
 * supervisors left them behind with PPID=1. Nothing reaped them.
 *
 * An "orphan" supervisor here is one that meets ALL of:
 *
 *   1. Its `pid` is alive.
 *   2. Its status file (--runtime-dir/sessions/<sessionId>.json) names
 *      a pid that matches itself (i.e. it's the recorded owner) AND
 *   3. No process matching the "live API" set is its ancestor.
 *
 * The third clause is what makes it safe to run alongside a live API:
 * if you give the reaper the pid of your current API server (or its
 * parent supervisor) it will refuse to kill anyone in that subtree.
 *
 * Env:
 *   PIRPC_REAPER_RUNTIME_DIR   directory to scan (e.g. /tmp/pi-crust)
 *                              required.
 *   PIRPC_REAPER_LIVE_API_PIDS comma-separated list of "live" API pids.
 *                              Their descendants are never reaped. If
 *                              empty, every supervisor is fair game.
 *   PIRPC_REAPER_DRY_RUN       "1" = print would-reap and exit 0;
 *                              "0" (default) = actually SIGTERM.
 *   PIRPC_REAPER_GRACE_MS      ms to wait between SIGTERM and SIGKILL
 *                              (default 2000).
 *
 * Usage:
 *   node scripts/reap-supervisors.mjs
 *
 * Exit code 0 always (this is a sweeper; failures are logged, not raised).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const RUNTIME_DIR = process.env.PIRPC_REAPER_RUNTIME_DIR;
const LIVE_API_PIDS = new Set(
  (process.env.PIRPC_REAPER_LIVE_API_PIDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0),
);
const DRY_RUN = process.env.PIRPC_REAPER_DRY_RUN === "1";
const GRACE_MS = Number(process.env.PIRPC_REAPER_GRACE_MS ?? 2000);

function log(msg) {
  process.stdout.write(`[reap-supervisors ${new Date().toISOString()}] ${msg}\n`);
}

if (!RUNTIME_DIR) {
  log("PIRPC_REAPER_RUNTIME_DIR is required");
  process.exit(64);
}

function readProcStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) return null;
    const after = stat.slice(lastParen + 1).trim().split(/\s+/);
    return { pid, ppid: Number(after[1]), pgid: Number(after[2]) };
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && err.code === "EPERM"; }
}

function isDescendantOfAny(pid, ancestors) {
  if (ancestors.size === 0) return false;
  const seen = new Set();
  let cur = pid;
  while (cur && cur !== 1 && !seen.has(cur)) {
    if (ancestors.has(cur)) return true;
    seen.add(cur);
    const stat = readProcStat(cur);
    if (!stat) return false;
    cur = stat.ppid;
  }
  return false;
}

function loadStatusFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(dir, entry);
    try {
      const text = fs.readFileSync(full, "utf8");
      const status = JSON.parse(text);
      if (status && typeof status.pid === "number") {
        out.push({ file: full, status });
      }
    } catch {
      // unreadable / partial write — skip; we won't blindly kill on guesses.
    }
  }
  return out;
}

function main() {
  const sessionsDir = path.join(RUNTIME_DIR, "sessions");
  const found = loadStatusFiles(sessionsDir);
  if (found.length === 0) {
    log(`no orphans (no status files under ${sessionsDir})`);
    process.exit(0);
  }

  const candidates = [];
  for (const { file, status } of found) {
    if (!isAlive(status.pid)) {
      // Status file points at a dead pid — just clean the stale file.
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      if (typeof status.socketPath === "string") {
        try { fs.unlinkSync(status.socketPath); } catch { /* ignore */ }
      }
      continue;
    }
    if (isDescendantOfAny(status.pid, LIVE_API_PIDS)) {
      // Owned by a live api — leave it.
      continue;
    }
    candidates.push(status);
  }

  if (candidates.length === 0) {
    log(`no orphans (0 supervisors are owned by a non-live API)`);
    process.exit(0);
  }

  log(`found ${candidates.length} orphan supervisor(s) (live-api filter: ${[...LIVE_API_PIDS].join(",") || "(none)"})`);

  if (DRY_RUN) {
    for (const c of candidates) log(`would reap pid=${c.pid} sessionId=${c.sessionId} socket=${c.socketPath ?? "?"}`);
    log(`dry-run complete (${candidates.length} would be reaped)`);
    process.exit(0);
  }

  for (const c of candidates) {
    try {
      process.kill(c.pid, "SIGTERM");
      log(`sent SIGTERM pid=${c.pid} sessionId=${c.sessionId}`);
    } catch (err) {
      log(`SIGTERM pid=${c.pid} failed: ${err && err.message ? err.message : err}`);
    }
  }
  // Wait, then escalate any that ignored TERM.
  setTimeout(() => {
    let stillAlive = 0;
    for (const c of candidates) {
      if (isAlive(c.pid)) {
        try { process.kill(c.pid, "SIGKILL"); log(`escalated to SIGKILL pid=${c.pid}`); stillAlive++; }
        catch { /* gone */ }
      }
    }
    log(`reaped ${candidates.length - stillAlive}/${candidates.length} cleanly; ${stillAlive} required SIGKILL`);
    process.exit(0);
  }, GRACE_MS).unref();
}

main();
