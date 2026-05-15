#!/usr/bin/env node
/**
 * Self-supervising git puller. Runs `git fetch origin <branch>` +
 * `git pull --ff-only` in a loop and logs its activity. If the inner
 * pull loop ever throws or its child processes get killed, the outer
 * supervisor catches it and restarts the loop after a brief delay so
 * we never silently stop polling — the failure mode that delivered an
 * ~80-minute window where merged PRs didn't land on the dev box
 * because the puller subshell inside prc-loop.sh had quietly died
 * with no respawn logic.
 *
 * Usage:
 *   node scripts/dev-git-puller.mjs
 *
 * Env:
 *   DEV_GIT_PULL_BRANCH      branch to track     (default "main")
 *   DEV_GIT_PULL_INTERVAL_S  seconds between pulls (default 15)
 *   DEV_GIT_PULL_LOG         path for the human-readable log
 *                            (default: $LOG_DIR/git-pull.log if set,
 *                             else <repo>/logs/git-pull.log)
 *   DEV_GIT_PULL_REPO_DIR    repo to operate in (default: cwd)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const BRANCH = process.env.DEV_GIT_PULL_BRANCH || "main";
const INTERVAL_S = Number(process.env.DEV_GIT_PULL_INTERVAL_S ?? 15);
const REPO_DIR = process.env.DEV_GIT_PULL_REPO_DIR || process.cwd();
const LOG_PATH = process.env.DEV_GIT_PULL_LOG
  ?? path.join(process.env.LOG_DIR ?? path.join(REPO_DIR, "logs"), "git-pull.log");

function log(msg) {
  const line = `[git-puller ${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch (err) {
    process.stderr.write(`[git-puller] log append failed: ${err?.message ?? err}\n`);
  }
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error,
  };
}

async function pullOnce() {
  const fetched = runGit(["fetch", "origin", BRANCH, "--quiet"]);
  if (fetched.error || fetched.code !== 0) {
    log(`fetch failed (code=${fetched.code}): ${fetched.error?.message ?? fetched.stderr}`);
    return;
  }
  const pulled = runGit(["pull", "--ff-only", "origin", BRANCH]);
  if (pulled.code !== 0) {
    log(`pull failed (code=${pulled.code}): ${pulled.stderr || pulled.stdout}`);
    return;
  }
  const lines = pulled.stdout.split("\n").filter(Boolean);
  // Quiet on no-op pulls; verbose on real updates.
  const interesting = lines.find((l) => /Updating|Fast-forward|new files?:/.test(l));
  if (interesting) {
    log(`pulled ${BRANCH}: ${lines.join(" | ")}`);
  }
}

async function main() {
  log(`starting (repo=${REPO_DIR}, branch=${BRANCH}, interval=${INTERVAL_S}s, log=${LOG_PATH})`);
  let shuttingDown = false;
  const stop = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${sig}, exiting`);
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  // Outer supervisor: if the inner loop throws (unlikely but defensive),
  // log it and resume. This is the lesson learned from prc-loop.sh's
  // puller, which had no such guard and died silently.
  for (;;) {
    if (shuttingDown) return;
    try {
      await pullOnce();
    } catch (err) {
      log(`pullOnce threw: ${err?.message ?? err} — continuing`);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_S * 1_000));
  }
}

void main();
