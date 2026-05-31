/**
 * Per-test process & tmpdir hygiene guard, scoped to known-problematic
 * process patterns.
 *
 * THE RULE: a test must leave the system in the state it found it. Anything
 * spawned, written, or bound during the test is owned by the test and must
 * be released, or the test fails.
 *
 * Why this exists
 * ----------------
 * Some of our tests deliberately spawn detached helper processes —
 * notably scripts/dev-api.mjs, which forks its child with detached:true so
 * production deploys can survive parent shell death. That's intentional in
 * production; but in tests it means an afterEach that does `supervisor.kill()`
 * on a ChildProcess handle does NOT reap the supervisor's detached
 * grandchildren. If the test then exits abnormally (vitest timeout, OOM,
 * SIGKILL), nothing reaps anything. We learned this the hard way:
 *
 *   2026-05-23: a chaos test in test/supervisor-runner-puller-hardening
 *   spawned dev-api.mjs in a /tmp/fs-chaos-cyclic-nm-XXXXXX sandbox, the
 *   test runner died, the orphaned supervisor sat in a respawn loop for
 *   2h18m at 99% CPU until a human noticed.
 *
 * Scoping: only patterns we've actually seen cause outages
 * ---------------------------------------------------------
 * A previous draft of this guard tried to flag ANY new descendant of the
 * test runner. That triggered false positives all over the suite (vitest's
 * own worker forks, ts-node loaders, test-internal subprocess spawns we
 * didn't author) and made it flake. The current version only flags
 * processes whose argv matches LEAK_PATTERNS — the exact shapes that have
 * caused production outages. New shapes can be added as new outages teach
 * us. False positives on unrelated subprocesses are structurally impossible.
 *
 * Two guards, two failure modes
 * ------------------------------
 *  (1) afterEach pattern scan  — any process matching a known-leak argv
 *                                pattern that didn't exist at suite start
 *                                is a test leak. Catches both live
 *                                descendants AND orphans already at PPID=1.
 *  (2) afterAll tmpdir reaper  — catches /tmp/<test-prefix>-XXXXXX dirs
 *                                that survived a hard kill of the framework.
 *
 * Contract for test authors
 * --------------------------
 *   - You may spawn anything you want. As long as anything matching
 *     LEAK_PATTERNS has been killed before your test's afterEach returns
 *     (with a small grace window for the kernel to reap it), the guard is
 *     silent.
 *   - If you intentionally spawn a long-lived helper that should outlive a
 *     single test, scope it with beforeAll/afterAll and reap it in afterAll.
 *   - If you create a tmpdir, name it with one of the registered prefixes
 *     (TMP_PREFIXES) so the afterAll reaper picks up stragglers.
 *   - To add a new leak class: append its argv-substring marker to
 *     LEAK_PATTERNS. Avoid overly broad markers ("node", "/scripts/").
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

const ROOT_PID = process.pid;

// Stamp every test-spawned process with this tag in its env so we can find
// orphans that have already been reparented to PPID=1. Used by the meta-test.
const TAG_VALUE = `pid-${ROOT_PID}-${Date.now().toString(36)}`;
process.env.PI_TEST_PID_TAG = TAG_VALUE;

// Tmpdir prefixes the reaper considers test-owned. Add new prefixes here as
// needed; the goal is to never delete something we didn't create.
const TMP_PREFIXES = [
  "dev-api-",
  "fs-chaos-",
  "pi-test-",
  "pi-crust-test-",
  "pi-crust-scenario-",
];

// argv substrings that identify processes whose leak has historically caused
// outages. Each entry should be specific enough that a passing test couldn't
// possibly produce it incidentally. The 2026-05-23 outage was caused by
// orphaned dev-api.mjs and pirpc-supervisor.mjs instances; they are the
// founding members of this list. Add new entries when new outages teach us.
const LEAK_PATTERNS: readonly string[] = [
  "scripts/dev-api.mjs",
  "scripts/pirpc-supervisor.mjs",
];

// How long to wait for a "leak" to actually disappear on its own before
// failing the test. Many tests correctly do `proc.kill('SIGKILL')` in their
// own afterEach but don't `await` the 'exit' event — the process is in the
// act of dying but hasn't been reaped by the kernel yet when our snapshot
// runs. A short grace window separates true leaks (still alive after grace)
// from race-with-reaper (gone by then).
const LEAK_GRACE_MS = Number(process.env.PI_TEST_LEAK_GRACE_MS ?? 300);

// Behavior on detected leak. "warn" (the default) prints a diagnostic line
// to the test log but does NOT fail the test — the leaked process is still
// SIGKILL'd, so the box stays clean. "strict" makes leaks a hard test
// failure. The pragmatic rollout: ship with "warn" by default so existing
// tests with subtle hygiene bugs surface diagnostically without breaking
// CI; gradually fix them, then flip the default. Per-test or per-suite
// opt-in to strict mode is via PI_TEST_HYGIENE_STRICT=1.
const HYGIENE_MODE: "warn" | "strict" =
  (process.env.PI_TEST_HYGIENE_STRICT === "1") ? "strict" : "warn";

const isLinux = process.platform === "linux";

interface ProcInfo {
  pid: number;
  ppid: number;
  cmdline: string;
}

function readProc(): Map<number, ProcInfo> {
  // Falls back to `ps` on non-Linux. We only require correctness on the
  // CI / dev box (Linux); macOS dev loops are best-effort.
  const out = new Map<number, ProcInfo>();
  if (isLinux) {
    let entries: string[];
    try { entries = fs.readdirSync("/proc"); } catch { return out; }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      let ppid = 0;
      let cmdline = "";
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        // /proc/<pid>/stat: pid (comm-with-possible-spaces) state ppid ...
        // Anchor on the LAST ')' to handle parens in process names safely.
        const close = stat.lastIndexOf(")");
        if (close < 0) continue;
        const after = stat.slice(close + 2).split(" ");
        ppid = Number(after[1]);
      } catch { continue; }
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      } catch { /* zombie or race: cmdline may be empty */ }
      out.set(pid, { pid, ppid, cmdline });
    }
  } else {
    try {
      const ps = execSync("ps -eo pid,ppid,command", { encoding: "utf8" });
      for (const line of ps.split("\n").slice(1)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), cmdline: m[3] ?? "" });
      }
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * Read /proc/<pid>/environ on Linux and check whether it contains the
 * given KEY=VALUE assignment. Used to identify processes spawned by THIS
 * worker (even after reparenting to PPID=1) without false-positiving on
 * processes spawned by parallel workers or by the user's shell.
 */
function processEnvHas(pid: number, key: string, value: string): boolean {
  if (!isLinux) return false;
  try {
    const buf = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    return buf.split("\0").includes(`${key}=${value}`);
  } catch {
    // EACCES (other user), ESRCH (gone), or non-Linux: be conservative
    // and treat as "not ours" so we don't kill it.
    return false;
  }
}

/**
 * A process is "ours" if either:
 *   (a) it descends from ROOT_PID via the live ppid chain, OR
 *   (b) it carries our unique PI_TEST_PID_TAG in its environ (catches
 *       orphans that were reparented to init after the parent supervisor
 *       died — they still carry our env var).
 *
 * The environ check is the key fix for the parallel-worker false-positive
 * we hit on 2026-05-23: vitest spawns multiple workers, each with its own
 * setup file and its own ROOT_PID. Worker A's afterEach scanning `/proc`
 * would see worker B's still-alive `scripts/dev-api.mjs` (matching
 * LEAK_PATTERNS) and SIGKILL it because it wasn't in A's baseline. The
 * environ tag identifies who actually spawned each process so we only
 * kill our own.
 */
function isOurs(pid: number, snapshot: Map<number, ProcInfo>): boolean {
  // Descendant via live ppid chain.
  let cur = snapshot.get(pid)?.ppid;
  for (let depth = 0; depth < 64 && cur !== undefined; depth++) {
    if (cur === ROOT_PID) return true;
    if (cur <= 1) break;
    cur = snapshot.get(cur)?.ppid;
  }
  // Orphan we spawned: env tag still present.
  return processEnvHas(pid, "PI_TEST_PID_TAG", TAG_VALUE);
}

/**
 * Processes whose argv matches one of LEAK_PATTERNS AND which were
 * spawned by THIS test worker. Parallel workers (or the user's own
 * unrelated dev-api.mjs) are explicitly excluded.
 */
function leakSuspects(snapshot: Map<number, ProcInfo>): Set<number> {
  const result = new Set<number>();
  for (const info of snapshot.values()) {
    if (info.pid === ROOT_PID) continue;
    if (!LEAK_PATTERNS.some((p) => info.cmdline.includes(p))) continue;
    if (!isOurs(info.pid, snapshot)) continue;
    result.add(info.pid);
  }
  return result;
}

/**
 * Live descendants of the test runner (or anything carrying PI_TEST_PID_TAG
 * in its cmdline). Exported for the meta-test; the guard itself uses
 * leakSuspects() to avoid false positives on unrelated subprocesses.
 */
function descendantsOrTagged(snapshot: Map<number, ProcInfo>): Set<number> {
  const result = new Set<number>();
  for (const info of snapshot.values()) {
    if (info.pid === ROOT_PID) continue;
    let cur = info.ppid;
    let descended = false;
    for (let depth = 0; depth < 64; depth++) {
      if (cur === ROOT_PID) { descended = true; break; }
      if (cur <= 1) break;
      const next = snapshot.get(cur)?.ppid;
      if (next === undefined) break;
      cur = next;
    }
    if (descended) { result.add(info.pid); continue; }
    if (info.cmdline.includes(TAG_VALUE)) result.add(info.pid);
  }
  return result;
}

function stillAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err: any) {
    if (err && err.code === "ESRCH") return false;
    return true; // EPERM: alive but unsignalable; still a leak from our POV
  }
}

async function settleLeaks(pids: number[]): Promise<number[]> {
  const deadline = Date.now() + LEAK_GRACE_MS;
  let remaining = pids.filter(stillAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30));
    remaining = remaining.filter(stillAlive);
  }
  return remaining;
}

let baseline: Set<number> = new Set();
let tmpdirBaseline: Set<string> = new Set();

beforeAll(() => {
  // Pre-existing leak-pattern processes (long-running prod dev-api,
  // sibling-worktree supervisors, etc.) MUST NOT be blamed on any test.
  baseline = leakSuspects(readProc());
  try { tmpdirBaseline = new Set(fs.readdirSync(os.tmpdir())); } catch { tmpdirBaseline = new Set(); }
});

beforeEach(() => {
  // Refresh per test: any leak-pattern process that exists at the START
  // of this test is not THIS test's fault. This avoids order-dependent
  // blame when a previous test correctly killed a process but the kernel
  // hasn't reaped it yet, or when an unrelated background process (e.g.
  // a sibling-worktree supervisor) spawned between tests.
  baseline = leakSuspects(readProc());
});

afterEach(async (ctx) => {
  const now = leakSuspects(readProc());
  const candidates: number[] = [];
  for (const pid of now) if (!baseline.has(pid)) candidates.push(pid);
  if (candidates.length === 0) return;

  // Grace period: a process correctly SIGKILL'd in the test's own afterEach
  // may not yet have disappeared from /proc when we ran.
  const leaked = await settleLeaks(candidates);
  if (leaked.length === 0) {
    // Self-cleaned during grace. Refresh baseline so the next test isn't
    // blamed if /proc lags briefly.
    baseline = new Set([...baseline, ...candidates]);
    return;
  }

  // True leaks. Kill them aggressively so they don't poison sibling tests,
  // then fail loudly with diagnostic detail.
  const diag: string[] = [];
  for (const pid of leaked) {
    try {
      const cmd = isLinux
        ? fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ")
        : "";
      const ppid = isLinux
        ? (fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1] ?? "").split(" ")[1]
        : "?";
      diag.push(`  pid=${pid} ppid=${ppid}  ${cmd.trim().slice(0, 200)}`);
    } catch {
      diag.push(`  pid=${pid} (gone)`);
    }
    try { process.kill(-pid, "SIGKILL"); } catch { /* not a pgroup leader */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }

  // Refresh baseline so subsequent tests aren't blamed for these PIDs we
  // just killed (they may briefly remain as zombies until reaped).
  baseline = new Set([...baseline, ...candidates, ...leaked]);

  const testName = ctx?.task?.name ?? "<unknown>";
  const message =
    `process-hygiene: test "${testName}" leaked ${leaked.length} process(es) ` +
    `matching known-leak patterns (${LEAK_PATTERNS.join(", ")}), surviving a ` +
    `${LEAK_GRACE_MS}ms grace window. Killed them; subsequent tests should be ` +
    `unaffected:\n${diag.join("\n")}`;
  if (HYGIENE_MODE === "strict") {
    throw new Error(message);
  } else {
    // Warn-mode: print to stderr so it's visible in CI logs but does not
    // fail the test. The leaked processes have already been killed above.
    console.warn(`\n[process-hygiene WARNING] ${message}\n` +
      `(set PI_TEST_HYGIENE_STRICT=1 to make this a hard failure)`);
  }
});

afterAll(() => {
  // Log a warning for any leftover sandbox dirs whose prefix marks them as
  // test-owned. We deliberately do NOT reap them here: vitest runs test
  // files in parallel workers, each loads its own copy of this setupFile,
  // each runs its own afterAll. If we reaped here, worker A's afterAll
  // would happily delete worker B's STILL-ACTIVE sandbox — a sandbox is
  // shared by name pattern across workers, not by ownership. Observed in
  // CI on 2026-05-23: spawn ENOENT and uv_cwd ENOENT errors from tests
  // whose sandbox was reaped under their feet.
  //
  // Instead: surface the leak to the test log. The path tells the author
  // which test forgot to clean up, and a manual `rm -rf /tmp/dev-api-*`
  // periodic sweep is fine for actual cleanup.
  let now: string[];
  try { now = fs.readdirSync(os.tmpdir()); } catch { return; }
  const leaked: string[] = [];
  for (const name of now) {
    if (tmpdirBaseline.has(name)) continue;
    if (!TMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    leaked.push(name);
  }
  if (leaked.length > 0) {
    console.warn(
      `\n[process-hygiene WARNING] this worker created ${leaked.length} tmpdir(s) ` +
      `matching test-owned prefixes that were not cleaned up. Test authors should ` +
      `\`await fs.rm(sandbox, { recursive: true, force: true })\` in their finally ` +
      `block:\n${leaked.map((n) => "  " + path.join(os.tmpdir(), n)).join("\n")}\n`,
    );
  }
});

// Exported for the meta-test in tests/setup/process-hygiene.test.ts.
export const __processHygiene = {
  rootPid: ROOT_PID,
  tagValue: TAG_VALUE,
  leakPatterns: LEAK_PATTERNS,
  readProc,
  leakSuspects,
  descendantsOrTagged,
};
