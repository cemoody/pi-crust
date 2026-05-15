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

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
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

function log(msg) {
  console.log(`[dev-api ${new Date().toISOString()}] ${msg}`);
}

// --- child lifecycle -------------------------------------------------

function spawnChild() {
  if (shuttingDown) return;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }

  child = spawn(COMMAND[0], COMMAND.slice(1), {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  const pid = child.pid;
  log(`spawned pid=${pid}: ${COMMAND.join(" ")}`);

  child.on("exit", (code, signal) => {
    log(`child pid=${pid} exited code=${code} signal=${signal}`);
    child = null;
    if (shuttingDown) return;
    respawnTimer = setTimeout(spawnChild, RESTART_DELAY_MS);
  });

  child.on("error", (err) => {
    log(`child spawn error: ${err.message}`);
    // 'error' events are typically followed by 'exit'; the exit handler
    // will schedule the respawn.
  });
}

function triggerRestart(reason) {
  if (shuttingDown) return;
  if (!child) {
    log(`change detected (${reason}) but no child to restart; will be picked up on next spawn`);
    return;
  }
  log(`change detected (${reason}) — SIGTERM pid=${child.pid}`);
  try { child.kill("SIGTERM"); } catch { /* already dead */ }
  // Escalate to SIGKILL if the child resists shutdown.
  const target = child;
  setTimeout(() => {
    if (child === target && child) {
      log(`child still alive after 10s; escalating to SIGKILL`);
      try { child.kill("SIGKILL"); } catch {}
    }
  }, 10_000).unref();
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (child) {
    log(`shutdown: SIGTERM pid=${child.pid}`);
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (child) { try { child.kill("SIGKILL"); } catch {} }
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
