#!/usr/bin/env node
/**
 * Outer restart loop for the api with a built-in file watcher.
 *
 * Replaces the previous `tsx watch` default, which has a fatal hang when
 * its child crashes during *startup* (vs. while running). That hang shows
 * up reliably in the wild: any time prc-loop.sh's git puller pulls a PR
 * that touches multiple files, tsx watch sees an `unlink` event mid-pull,
 * triggers a restart, and the restarted child crashes when tsx's loader
 * tries to read package.json while git is mid-rewrite. tsx watch then
 * stays alive forever waiting for the next file event; no auto-retry.
 *
 * This script:
 *
 *   1. Spawns the api as a child process with stdio inherited.
 *   2. Watches src/server/** with node's built-in fs.watch(recursive:true)
 *      plus a debounce window that's longer than a typical `git pull`'s
 *      multi-file rewrite burst. Concurrent rapid changes coalesce into a
 *      single restart.
 *   3. On debounced change: SIGTERM the child. The api's existing detach
 *      handler in http-api-server.ts releases pirpc supervisors gracefully
 *      so active sessions survive.
 *   4. On child exit — whether from SIGTERM, EADDRINUSE, startup parse
 *      error, or anything else — sleep RESTART_DELAY_MS and respawn. This
 *      is the key invariant that's broken with `tsx watch`: failures
 *      ALWAYS lead to "retry in N ms" eventually. Never hang.
 *   5. On SIGTERM/SIGINT to ourselves: kill the child and exit.
 *
 * Usage:
 *   node scripts/dev-api.mjs -- <command...>
 *   e.g.  node scripts/dev-api.mjs -- npm run dev:api
 *
 * Env:
 *   DEV_API_DEBOUNCE_MS   debounce window in ms (default 500)
 *   DEV_API_RESTART_MS    delay before respawn after exit (default 800)
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// --- config -----------------------------------------------------------

const WATCH_DIR = path.join(projectRoot, "src", "server");

// Long enough to outlast a typical `git pull`'s multi-file rewrite burst.
// Empirically a 16-file PR merge with package.json rewrite finishes in
// ~50–150 ms; we wait significantly longer than that before reacting.
const DEBOUNCE_MS = Number(process.env.DEV_API_DEBOUNCE_MS ?? 500);

// Delay between child exit and respawn. Gives the kernel time to reap and
// the TCP port to clear; also limits churn if the api can't boot (e.g. a
// git-pull-in-progress leaves package.json transiently corrupt — the child
// crashes, we back off, retry, eventually pull is done and boot succeeds).
const RESTART_DELAY_MS = Number(process.env.DEV_API_RESTART_MS ?? 800);

// Optional hint: when set, the supervisor probes the listeners on this
// TCP port whenever the child exits with a non-zero code, and logs the
// holder's pid + cwd + cmdline. Without this hint a port collision is
// completely opaque — the operator sees only "already in use" and has
// no idea what's holding the port. The probe + log are throttled to
// ELEVATION_INTERVAL_MS so a crash-loop doesn't fill the log.
//
// Default: 8787 (the api's own port). Tests override via DEV_API_PORT_HINT.
const PORT_HINT = Number(process.env.DEV_API_PORT_HINT ?? 8787);
const ELEVATION_INTERVAL_MS = Number(process.env.DEV_API_ELEVATION_INTERVAL_MS ?? 30_000);

// File extensions worth watching. Tests are excluded so editing tests
// doesn't bounce the api.
const SOURCE_PATTERN = /\.(ts|tsx|mjs|cjs|js)$/;
const TEST_PATTERN = /\.test\.(ts|tsx|js)$/;

// --- argv parsing ----------------------------------------------------

function parseCommand() {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf("--");
  const cmd = dd === -1 ? argv : argv.slice(dd + 1);
  if (cmd.length === 0) {
    console.error("usage: dev-api.mjs -- <command...>");
    process.exit(64);
  }
  return cmd;
}
const COMMAND = parseCommand();

// --- state -----------------------------------------------------------

let child = null;
let shuttingDown = false;
let respawnTimer = null;
let debounceTimer = null;
let pendingFiles = new Set();
let lastElevationLogAt = 0;

function log(msg) {
  console.log(`[dev-api ${new Date().toISOString()}] ${msg}`);
}

// --- child lifecycle -------------------------------------------------

/**
 * Signal the child's entire process group. `child` is spawned with
 * `detached: true`, which makes the child a new process-group leader.
 * Its pid is the group id, and `process.kill(-pid, sig)` signals every
 * process in the group — npm, sh, tsx, node, all of it.
 *
 * WHY: with a plain `child.kill(sig)` only the immediate child receives
 * the signal. npm in particular does NOT forward signals to its sh/node
 * descendants reliably, so npm exits and leaves the actual http-api-server
 * node process orphaned, still holding port 8787. The next respawn then
 * fails forever with EADDRINUSE.
 */
function killGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (err) {
    // If the group is already gone the kill throws ESRCH; treat as success.
    if (err && err.code !== "ESRCH") {
      log(`kill(-${pid}, ${signal}) failed: ${err.message}`);
    }
  }
}

/**
 * Detect and repair a node_modules tree that's been clobbered such that
 * `spawn()` of an npm-resolved binary (e.g. tsx, npm itself) hits ELOOP.
 * Returns true if a heal was actually performed (caller should schedule
 * a respawn after a short delay so the fresh node_modules has time to
 * materialize).
 *
 * Two known pathological states, both observed multiple times in 24h:
 *
 *   (A) `node_modules` itself is a self-referential symlink:
 *         $ ls -la node_modules
 *         lrwxrwxrwx ... node_modules -> ../<this-dir-name>/node_modules
 *       Root cause: an agent ran `ln -s ../pi-remote-control/node_modules
 *       node_modules` from INSIDE the canonical worktree (the recipe is
 *       correct for sibling worktrees but loops on the canonical one).
 *
 *   (B) `node_modules` is a normal directory but contains a nested
 *       symlink that ELOOPs (e.g. `node_modules/tsx` → `../tsx` from a
 *       half-finished install, or any other bad symlink). The previous
 *       version of this heal bailed early via `!stat.isSymbolicLink()`
 *       and the supervisor would sit in `Will retry` forever with no
 *       API up. Observed 2026-05-23: a 33-minute outage where `dev:api`
 *       loop-spammed `spawn() threw synchronously: spawn ELOOP. Will
 *       retry.` until a human ran `npm install` manually.
 *
 * Heal procedure:
 *   - Case (A): unlink the bad symlink, then `npm install`.
 *   - Case (B): just `npm install` (it'll repair whatever's broken).
 * `npm install` is the same thing a human would do; we just do it
 * automatically because the same mistakes recur often enough that
 * paying the ~7s warm-cache cost is much cheaper than a human-in-the-loop.
 *
 * A small cooldown prevents tight respawn → spawn ELOOP → heal → respawn
 * loops if `npm install` itself can't fix the underlying breakage.
 */
let lastHealAt = 0;
const HEAL_COOLDOWN_MS = 30_000;

function tryHealCyclicNodeModules() {
  const now = Date.now();
  if (now - lastHealAt < HEAL_COOLDOWN_MS) {
    log(`heal cooldown active (${Math.round((HEAL_COOLDOWN_MS - (now - lastHealAt)) / 1000)}s left); skipping`);
    return false;
  }

  const nm = path.join(projectRoot, "node_modules");

  // Case (A): node_modules itself is a cyclic symlink. Detect and unlink
  // BEFORE we let npm install try (npm install will refuse to install
  // into a symlink that doesn't resolve).
  let stat = null;
  try { stat = fsSync.lstatSync(nm); } catch { /* missing is fine */ }
  if (stat && stat.isSymbolicLink()) {
    let target = "<unreadable>";
    try { target = fsSync.readlinkSync(nm); } catch { /* ignore */ }
    let isCyclic = false;
    try { fsSync.realpathSync(nm); }
    catch (err) { if (err && err.code === "ELOOP") isCyclic = true; }
    if (isCyclic) {
      log(`detected cyclic node_modules symlink (target=${target}). Removing before npm install.`);
      try { fsSync.unlinkSync(nm); }
      catch (err) {
        log(`failed to unlink bad symlink: ${err && err.message ? err.message : err}`);
        return false;
      }
    } else {
      // A non-cyclic symlink (e.g. sibling worktree sharing canonical
      // install) is by design and is NOT the bug. Don't touch it; let
      // the user/operator figure out what's wrong. Falling through here
      // would let npm install rewrite the symlink, which is bad.
      log(`node_modules is a symlink (target=${target}) but resolves cleanly; nothing to heal here`);
      return false;
    }
  }

  // Case (B): `node_modules` is a directory (or just got unlinked in case
  // A) but spawn() still ELOOPed — meaning the bad symlink is nested.
  // Reproducing the exact offender is finicky and not worth it: just run
  // `npm install`, which fixes whatever's broken (missing dirs, bad
  // symlinks, half-installed packages).
  lastHealAt = now;
  log(`running \`npm install --no-audit --no-fund\` to rebuild node_modules…`);
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status === 0) {
    log(`npm install completed; the next respawn should succeed.`);
    return true;
  }
  log(`npm install exited code=${result.status} signal=${result.signal}; next respawn will retry the heal after cooldown.`);
  return false;
}

/**
 * On EADDRINUSE-shaped failures, probe the port the api is supposed
 * to bind and log the holder's pid, cwd, and cmdline. Throttled to
 * ELEVATION_INTERVAL_MS so a fast crash-loop doesn't spam the log.
 */
function logPortHolderIfAny() {
  if (!PORT_HINT || PORT_HINT <= 0) return;
  const now = Date.now();
  if (now - lastElevationLogAt < ELEVATION_INTERVAL_MS) return;
  const holders = findTcpListeners(PORT_HINT);
  if (holders.length === 0) return;
  for (const pid of holders) {
    const meta = readProcMeta(pid);
    log(`port ${PORT_HINT} still held by pid=${pid} cwd=${meta.cwd} cmd=${meta.cmd}`);
  }
  lastElevationLogAt = now;
}

function findTcpListeners(port) {
  // Prefer ss; fall back to lsof; fall back to /proc/net/tcp scan.
  const ss = spawnSync("ss", ["-tlnpH", `sport = :${port}`], { encoding: "utf8" });
  if (ss.status === 0 && ss.stdout) {
    const pids = new Set();
    for (const m of ss.stdout.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
    return [...pids];
  }
  const lsof = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (lsof.status === 0 && lsof.stdout) {
    return lsof.stdout.trim().split("\n").filter(Boolean).map(Number);
  }
  return [];
}

function readProcMeta(pid) {
  try {
    const cmdline = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replace(/\0+$/, "").split("\0").join(" ").trim();
    const cwd = fsSync.readlinkSync(`/proc/${pid}/cwd`);
    return { cwd, cmd: cmdline || "(unknown)" };
  } catch {
    return { cwd: "?", cmd: "?" };
  }
}

function scheduleRespawn(reason) {
  if (shuttingDown) return;
  if (respawnTimer) return; // already queued
  if (reason) log(`scheduling respawn in ${RESTART_DELAY_MS}ms (${reason})`);
  respawnTimer = setTimeout(spawnChild, RESTART_DELAY_MS);
}

function spawnChild() {
  if (shuttingDown) return;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }

  // `spawn()` can throw SYNCHRONOUSLY for immediate failures like ENOENT,
  // EACCES, or ELOOP (cyclic symlink — e.g. node_modules pointing at
  // itself). Without this try/catch the exception escapes the supervisor
  // entirely and the whole `npm run dev:api:loop` chain crashes, leaving
  // the api down with no respawn. Observed in the wild after a separate
  // bug recreated the cyclic node_modules symlink.
  try {
    child = spawn(COMMAND[0], COMMAND.slice(1), {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
      // New process group: child.pid is the group leader. Lets us signal the
      // entire tree (npm → sh → tsx → node) atomically via process.kill(-pid).
      detached: true,
    });
  } catch (err) {
    log(`spawn() threw synchronously: ${err && err.message ? err.message : err}. Will retry.`);
    child = null;
    // ELOOP at spawn-time is almost always a cyclic node_modules symlink
    // (the canonical install pointing at itself). It's a known recurring
    // failure mode — see scripts/safe-symlink-node-modules.sh for the
    // recipe that prevents it. Try to heal it automatically so the api
    // doesn't sit in a permanent retry loop while waiting for a human.
    if (err && err.code === "ELOOP") {
      const healed = tryHealCyclicNodeModules();
      if (healed) scheduleRespawn("after node_modules heal");
      else scheduleRespawn("sync ELOOP, heal deferred/failed");
    } else {
      scheduleRespawn("sync spawn() failure");
    }
    return;
  }

  // Attach the error handler IMMEDIATELY (before any short-circuit) so an
  // async 'error' event from a half-spawned child doesn't become an
  // uncaughtException at the supervisor level. spawn() can return a ChildProcess
  // handle with no pid (e.g. ENOENT happens async on some platforms); the
  // child then emits 'error', and without a listener Node converts that to
  // a fatal exception.
  if (child) {
    child.on("error", (err) => {
      // Async spawn errors. Diagnostic only; the matching 'exit' (or our
      // early-return below) will schedule the respawn.
      log(`child spawn error (async): ${err && err.message ? err.message : err}`);
    });
  }

  // Even if spawn() returns, the child might be in a half-broken state.
  // child.pid is undefined when the platform refused the spawn outright.
  if (!child || child.pid == null) {
    log(`spawn() returned no pid. Treating as failure; will retry.`);
    child = null;
    scheduleRespawn("no pid after spawn");
    return;
  }

  const pid = child.pid;
  log(`spawned pid=${pid} (pgid=${pid}): ${COMMAND.join(" ")}`);

  child.on("exit", (code, signal) => {
    log(`child pid=${pid} exited code=${code} signal=${signal}`);
    // Reap any grandchildren that survived the group signal (defensive;
    // shouldn't happen but we paid the cost once already).
    killGroup(pid, "SIGKILL");
    child = null;
    // EADDRINUSE-shaped exits (non-zero code, no signal) are almost
    // always a port collision with another supervisor or a stale
    // orphan. Probe the configured port and log the holder's identity
    // so the operator has something actionable. logPortHolderIfAny is
    // internally throttled to once per ELEVATION_INTERVAL_MS.
    if (code !== 0 && code !== null && signal === null) logPortHolderIfAny();
    scheduleRespawn();
  });

  // (the async 'error' handler is attached above, before the pid check)
}

// One last belt-and-suspenders: if any unhandled async failure reaches
// the top of the supervisor, log it and try to keep going rather than
// letting the process die. The api can't restart if the supervisor is
// dead, so this is the difference between "glitch survives" and "sysop
// has to manually `npm run dev:api:loop` again".
process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err && err.stack ? err.stack : err}`);
  scheduleRespawn("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
  scheduleRespawn("unhandledRejection");
});

function triggerRestart(reason) {
  if (shuttingDown) return;
  if (!child) {
    log(`change detected (${reason}) but no child to restart; will be picked up on next spawn`);
    return;
  }
  const pid = child.pid;
  log(`change detected (${reason}) — SIGTERM pgid=${pid}`);
  killGroup(pid, "SIGTERM");
  // Escalate to SIGKILL if the group resists shutdown.
  const target = child;
  setTimeout(() => {
    if (child === target && child) {
      log(`child still alive after 10s; escalating to SIGKILL pgid=${pid}`);
      killGroup(pid, "SIGKILL");
    }
  }, 10_000).unref();
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (child) {
    const pid = child.pid;
    log(`shutdown: SIGTERM pgid=${pid}`);
    killGroup(pid, "SIGTERM");
    setTimeout(() => {
      if (child) {
        log(`shutdown: SIGKILL pgid=${pid} (graceful TERM didn't take)`);
        killGroup(pid, "SIGKILL");
      }
      process.exit(0);
    }, 8000).unref();
  } else {
    process.exit(0);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- file watcher ----------------------------------------------------

async function startWatcher() {
  log(`watching ${path.relative(projectRoot, WATCH_DIR)} (debounce ${DEBOUNCE_MS}ms, restart delay ${RESTART_DELAY_MS}ms)`);
  try {
    const watcher = fs.watch(WATCH_DIR, { recursive: true });
    for await (const event of watcher) {
      if (shuttingDown) break;
      const file = event.filename ?? "";
      if (!file) continue;
      if (!SOURCE_PATTERN.test(file)) continue;
      if (TEST_PATTERN.test(file)) continue;
      pendingFiles.add(file);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const files = [...pendingFiles];
        pendingFiles = new Set();
        debounceTimer = null;
        const reason = files.length === 1 ? files[0] : `${files.length} files`;
        triggerRestart(reason);
      }, DEBOUNCE_MS);
    }
  } catch (err) {
    log(`watcher error: ${err instanceof Error ? err.message : err}`);
    // Don't crash the supervisor on watcher failure — the api can still
    // be restarted by an external SIGTERM via the outer loop.
  }
}

// --- go --------------------------------------------------------------

spawnChild();
void startWatcher();
