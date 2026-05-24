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
 *                            Special value "HEAD": resolve to the currently
 *                            checked-out branch on each iteration. Useful
 *                            when the worktree may be on a non-main release
 *                            branch — the old hard-coded "main" caused an
 *                            8-day silent fast-forward failure on the dev
 *                            box (2026-05-23 incident).
 *   DEV_GIT_PULL_INTERVAL_S          seconds between pulls (default 15)
 *   DEV_GIT_PULL_SUMMARY_INTERVAL_S  after a failure streak, how often to
 *                                    re-emit the summary line (default 300).
 *                                    Without this the bash puller hit
 *                                    46k identical lines / 10 MB / 8 days.
 *   DEV_GIT_PULL_LOG         path for the human-readable log
 *                            (default: $LOG_DIR/git-pull.log if set,
 *                             else <repo>/logs/git-pull.log)
 *   DEV_GIT_PULL_REPO_DIR    repo to operate in (default: cwd)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const BRANCH_ENV = process.env.DEV_GIT_PULL_BRANCH || "main";
const INTERVAL_S = Number(process.env.DEV_GIT_PULL_INTERVAL_S ?? 15);
const SUMMARY_INTERVAL_S = Number(process.env.DEV_GIT_PULL_SUMMARY_INTERVAL_S ?? 300);
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

/**
 * Resolve the branch we should pull. Either the literal env value (e.g.
 * "main", "release/pi-crust-0.1.0") or, when env="HEAD", the current
 * checked-out branch. HEAD-resolution makes the puller safe on release
 * branches where hard-coding main produces guaranteed-fail pulls.
 */
function resolveBranch() {
  if (BRANCH_ENV !== "HEAD") return { name: BRANCH_ENV, resolved: false };
  const r = runGit(["symbolic-ref", "--short", "HEAD"]);
  if (r.code !== 0 || !r.stdout) {
    return { name: "main", resolved: false, fallback: true };
  }
  return { name: r.stdout.trim(), resolved: true };
}

// Failure-streak coalescing state. The goal is: log a failure ONCE, then
// be quiet about identical follow-ups until either (a) we recover or
// (b) SUMMARY_INTERVAL_S has elapsed, at which point we re-emit a brief
// reminder. The bash puller this replaces logged on every iteration,
// which produced 46k repeated entries / 10 MB / 8 days of unread spam.
const streak = {
  signature: null,         // distinct identity of the current failure
  consecutive: 0,          // how many times in a row we've seen it
  firstAt: 0,              // ms
  lastSummaryAt: 0,        // ms
};

function failureSignature(stage, payload) {
  // Collapse whitespace + drop ephemeral fields. We just want "is this
  // the same failure as last time".
  const norm = (payload || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return `${stage}:${norm}`;
}

function onFailure(stage, payload) {
  const sig = failureSignature(stage, payload);
  const now = Date.now();
  if (sig !== streak.signature) {
    // New failure shape — always log it once.
    if (streak.consecutive > 0) {
      log(`failure mode changed; previous streak ended (${streak.consecutive} consecutive ${streak.signature})`);
    }
    streak.signature = sig;
    streak.consecutive = 1;
    streak.firstAt = now;
    streak.lastSummaryAt = now;
    log(`${stage} failed: ${payload}`);
    return;
  }
  streak.consecutive += 1;
  if (streak.consecutive === 2) {
    log(`(suppressing further identical "${stage}" failures until recovery or ${SUMMARY_INTERVAL_S}s elapses; consecutive=2)`);
  } else if (now - streak.lastSummaryAt > SUMMARY_INTERVAL_S * 1000) {
    log(`still failing identically: ${stage} × ${streak.consecutive} consecutive over ${Math.round((now - streak.firstAt) / 1000)}s`);
    streak.lastSummaryAt = now;
  }
}

function onSuccess(branch, lines) {
  if (streak.consecutive > 0) {
    log(`recovered after ${streak.consecutive} consecutive failures (${Math.round((Date.now() - streak.firstAt) / 1000)}s of failure streak)`);
    streak.signature = null;
    streak.consecutive = 0;
    streak.firstAt = 0;
  }
  const interesting = lines.find((l) => /Updating|Fast-forward|new files?:/.test(l));
  if (interesting) log(`pulled ${branch}: ${lines.join(" | ")}`);
}

async function pullOnce() {
  const branchInfo = resolveBranch();
  if (branchInfo.resolved) {
    // Cheap one-time-per-iteration hint so the log explains what HEAD resolved to.
    if (streak.consecutive === 0) log(`HEAD-resolved branch: ${branchInfo.name}`);
  } else if (branchInfo.fallback) {
    onFailure("HEAD-resolve", "git symbolic-ref --short HEAD failed; falling back to literal 'main'");
  }
  const branch = branchInfo.name;
  const fetched = runGit(["fetch", "origin", branch, "--quiet"]);
  if (fetched.error || fetched.code !== 0) {
    onFailure("fetch", `code=${fetched.code} ${fetched.error?.message ?? fetched.stderr}`);
    return;
  }
  const pulled = runGit(["pull", "--ff-only", "origin", branch]);
  if (pulled.code !== 0) {
    onFailure("pull", `code=${pulled.code} ${pulled.stderr || pulled.stdout}`);
    return;
  }
  onSuccess(branch, pulled.stdout.split("\n").filter(Boolean));
}

async function main() {
  log(`starting (repo=${REPO_DIR}, branch=${BRANCH_ENV}, interval=${INTERVAL_S}s, summary=${SUMMARY_INTERVAL_S}s, log=${LOG_PATH})`);
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
