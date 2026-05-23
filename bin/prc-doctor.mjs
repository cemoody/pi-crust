#!/usr/bin/env node
/**
 * prc-doctor — operator-facing dump of "is anything obviously wrong on
 * the dev box right now?" Used in two contexts:
 *
 *   1. Interactive: run during an incident to see at a glance which
 *      ports are held, how many supervisors exist, whether the puller
 *      is in a failure streak, etc.
 *   2. Test fixture: the predicates here ARE the same ones used by the
 *      regression tests. If a check ever passes here but the
 *      corresponding test fails (or vice versa), one of them is wrong.
 *
 * Sections:
 *   - Listening ports & holders
 *   - pirpc-supervisor processes (counts, by runtime-dir, by ppid)
 *   - Stale UDS sockets without a holder
 *   - Stale status files pointing at dead pids
 *   - Cyclic node_modules detection (case 1 + case 2)
 *   - Git puller log: most recent activity + failure-streak summary
 *
 * Exit code:
 *   0 = everything looks normal
 *   1 = at least one warning surface (orphans found, port collision,
 *       broken symlinks, stale UDS sockets)
 *
 * Env (all optional):
 *   PRC_DOCTOR_RUNTIME_DIRS   comma-separated runtime-dirs to scan
 *                             (default: /tmp/pi-crust,/tmp/pi-remote-control)
 *   PRC_DOCTOR_PORTS          comma-separated ports to probe
 *                             (default: 5173,8787,5174,8789)
 *   PRC_DOCTOR_PROJECT_ROOTS  comma-separated project roots to probe for
 *                             cyclic node_modules (default: cwd)
 *   PRC_DOCTOR_PULLER_LOGS    comma-separated git-pull.log paths to scan
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const RUNTIME_DIRS = (process.env.PRC_DOCTOR_RUNTIME_DIRS ?? "/tmp/pi-crust,/tmp/pi-remote-control")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PORTS = (process.env.PRC_DOCTOR_PORTS ?? "5173,8787,5174,8789")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const PROJECT_ROOTS = (process.env.PRC_DOCTOR_PROJECT_ROOTS ?? process.cwd())
  .split(",").map((s) => s.trim()).filter(Boolean);
const PULLER_LOGS = (process.env.PRC_DOCTOR_PULLER_LOGS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

let warningCount = 0;
function warn(msg) { warningCount++; process.stdout.write(`WARN  ${msg}\n`); }
function info(msg) { process.stdout.write(`info  ${msg}\n`); }
function head(msg) { process.stdout.write(`\n=== ${msg} ===\n`); }

function readProcMeta(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+$/, "").split("\0").join(" ").trim();
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    return { cwd, cmd, ppid: Number(after[1]) };
  } catch { return { cwd: "?", cmd: "?", ppid: 0 }; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && err.code === "EPERM"; }
}

// --- ports ----------------------------------------------------------

function tcpListenersOn(port) {
  const ss = spawnSync("ss", ["-tlnpH", `sport = :${port}`], { encoding: "utf8" });
  const pids = new Set();
  if (ss.status === 0 && ss.stdout) {
    for (const m of ss.stdout.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
  }
  return [...pids];
}

head("Listening ports");
for (const port of PORTS) {
  const holders = tcpListenersOn(port);
  if (holders.length === 0) { info(`port ${port}: free`); continue; }
  if (holders.length === 1) {
    const meta = readProcMeta(holders[0]);
    info(`port ${port}: pid=${holders[0]} ppid=${meta.ppid} cwd=${meta.cwd} cmd=${meta.cmd.slice(0, 100)}`);
  } else {
    warn(`port ${port}: ${holders.length} listeners (${holders.join(", ")}) \u2014 collision!`);
  }
}

// --- supervisors ---------------------------------------------------

head("pirpc-supervisor processes");
const allPids = (() => {
  try { return fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e)).map(Number); }
  catch { return []; }
})();
const supervisors = [];
for (const pid of allPids) {
  const meta = readProcMeta(pid);
  if (/pirpc-supervisor\.mjs/.test(meta.cmd)) supervisors.push({ pid, ...meta });
}
info(`total supervisors: ${supervisors.length}`);
{
  const byPpid = new Map();
  const byRuntime = new Map();
  for (const s of supervisors) {
    byPpid.set(s.ppid, (byPpid.get(s.ppid) ?? 0) + 1);
    const m = s.cmd.match(/--runtime-dir\s+(\S+)/);
    const runtime = m?.[1] ?? "(none)";
    byRuntime.set(runtime, (byRuntime.get(runtime) ?? 0) + 1);
  }
  for (const [ppid, count] of [...byPpid.entries()].sort((a, b) => b[1] - a[1])) {
    const label = ppid === 1 ? "init (orphaned)" : `pid ${ppid}`;
    info(`  ${count.toString().padStart(4)} \u00d7 ppid=${label}`);
    if (ppid === 1 && count > 5) warn(`  ${count} supervisors are orphaned (PPID=1) \u2014 reaper sweep recommended`);
  }
  for (const [runtime, count] of [...byRuntime.entries()].sort((a, b) => b[1] - a[1])) {
    info(`  ${count.toString().padStart(4)} \u00d7 runtime-dir ${runtime}`);
  }
}

// --- stale UDS sockets & status files ------------------------------

head("Runtime directories");
for (const runtime of RUNTIME_DIRS) {
  if (!fs.existsSync(runtime)) { info(`${runtime}: (does not exist)`); continue; }
  const sessionsDir = path.join(runtime, "sessions");
  const socketDir = path.join(runtime, "s");
  let staleStatus = 0;
  if (fs.existsSync(sessionsDir)) {
    for (const entry of fs.readdirSync(sessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(sessionsDir, entry);
      try {
        const status = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!isAlive(status.pid)) { staleStatus++; warn(`stale status: ${file} (pid ${status.pid} dead)`); }
      } catch { /* skip */ }
    }
  }
  let staleSocket = 0;
  if (fs.existsSync(socketDir)) {
    const ss = spawnSync("ss", ["-xlpnH"], { encoding: "utf8" });
    const sockText = ss.status === 0 ? ss.stdout : "";
    for (const entry of fs.readdirSync(socketDir)) {
      const sock = path.join(socketDir, entry);
      if (!sockText.includes(sock)) { staleSocket++; warn(`stale UDS socket (no holder): ${sock}`); }
    }
  }
  info(`${runtime}: ${staleStatus} stale status, ${staleSocket} stale sockets`);
}

// --- cyclic node_modules -------------------------------------------

head("Cyclic node_modules probes");
function probeCyclic(root) {
  const nm = path.join(root, "node_modules");
  let stat;
  try { stat = fs.lstatSync(nm); }
  catch { info(`${nm}: not present`); return; }
  if (stat.isSymbolicLink()) {
    try { fs.realpathSync(nm); info(`${nm}: symlink, resolves ok`); }
    catch (err) {
      if (err && err.code === "ELOOP") warn(`${nm}: SELF-REFERENTIAL SYMLINK \u2014 dev-api will crash-loop on spawn ELOOP`);
      else info(`${nm}: symlink, resolve error ${err && err.code}`);
    }
    return;
  }
  // Nested: probe a handful of canonical entry points.
  const candidates = [
    path.join(nm, ".bin", "tsx"),
    path.join(nm, "tsx"),
    path.join(nm, ".bin", "vite"),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try { fs.realpathSync(c); }
    catch (err) {
      if (err && err.code === "ELOOP") warn(`${c}: cyclic nested symlink \u2014 same class of bug as 2026-05-23 outage`);
    }
  }
  info(`${nm}: directory, no cyclic nested symlinks detected at canonical paths`);
}
for (const root of PROJECT_ROOTS) probeCyclic(root);

// --- puller logs ----------------------------------------------------

head("Git puller logs");
for (const logPath of PULLER_LOGS) {
  if (!fs.existsSync(logPath)) { info(`${logPath}: missing`); continue; }
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const tail = lines.slice(-30);
  const failedRecent = tail.filter((l) => /fail|fatal|Not possible to fast-forward/.test(l)).length;
  if (failedRecent > 20) warn(`${logPath}: ${failedRecent}/30 recent lines are failures \u2014 puller is broken`);
  else info(`${logPath}: ${tail.length} recent lines, ${failedRecent} are failures`);
}

process.exit(warningCount > 0 ? 1 : 0);
