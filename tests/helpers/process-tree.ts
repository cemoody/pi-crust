/**
 * Process-tree harness. The bugs that take down the dev box live in the
 * shape of the process tree — orphaned grandchildren, port holders we don't
 * own, supervisor processes adopted by init that never die — so a test
 * that asserts behavior at the *unix* level needs primitives that look at
 * /proc, ss, and the filesystem, not just the in-memory state of a child
 * handle.
 *
 * Everything here is Linux-first because that's where the dev box and CI
 * runners live. macOS uses lsof; we fall back to it when available, but
 * we don't pretend to be portable past that.
 *
 * Used by:
 *   - tests/regressions/*           (recreate observed incidents)
 *   - tests/integration/*           (when an assertion is "no orphans")
 *   - tests/smoke/*                 (production-shape lifecycle checks)
 *   - bin/prc-doctor.mjs            (same predicates, operator-facing)
 *
 * NOT exported from the package — strictly test-time.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  rss: number;       // kB
  startTime: number; // ticks since boot (procfs field 22)
  state: string;
  cmd: string;       // /proc/<pid>/cmdline joined with " "
}

/** Read /proc/<pid>/stat. Returns null if the pid is gone. */
export async function readProcStat(pid: number): Promise<ProcessRow | null> {
  let stat: string;
  let cmdline: string;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
  // /proc/<pid>/stat format is treacherous: comm is in parens and may
  // contain spaces. Slice from the last ')' to dodge it.
  const lastParen = stat.lastIndexOf(")");
  if (lastParen === -1) return null;
  const after = stat.slice(lastParen + 1).trim().split(/\s+/);
  // After comm, field indices shift by 2: state=0, ppid=1, pgrp=2, ...,
  // starttime=18 (field 22 in the man page = 22-3-1 = 18 here).
  const state = after[0] ?? "?";
  const ppid = Number(after[1] ?? 0);
  const pgid = Number(after[2] ?? 0);
  const startTime = Number(after[18] ?? 0);
  let rss = 0;
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+) kB/m);
    if (m) rss = Number(m[1]);
  } catch { /* exited between reads */ }
  const cmd = cmdline.replace(/\0+$/, "").split("\0").join(" ").trim();
  return { pid, ppid, pgid, rss, startTime, state, cmd };
}

/** Snapshot every process visible to /proc. */
export async function allProcesses(): Promise<ProcessRow[]> {
  const entries = await fs.readdir("/proc");
  const out: ProcessRow[] = [];
  await Promise.all(entries.map(async (entry) => {
    if (!/^\d+$/.test(entry)) return;
    const row = await readProcStat(Number(entry));
    if (row) out.push(row);
  }));
  return out;
}

/** Find all descendants of `pid` (transitive). Includes `pid` itself if `inclusive`. */
export async function descendantsOf(pid: number, inclusive = false): Promise<number[]> {
  const all = await allProcesses();
  const byParent = new Map<number, number[]>();
  for (const p of all) {
    const arr = byParent.get(p.ppid) ?? [];
    arr.push(p.pid);
    byParent.set(p.ppid, arr);
  }
  const out: number[] = inclusive ? [pid] : [];
  const stack = [pid];
  while (stack.length) {
    const next = stack.pop()!;
    const kids = byParent.get(next) ?? [];
    for (const kid of kids) { out.push(kid); stack.push(kid); }
  }
  return out;
}

/** Resolve the listener pids holding a TCP port. */
export async function tcpListenersOnPort(port: number): Promise<number[]> {
  // Prefer `ss` since it's available on every modern Linux image. Fall
  // back to /proc/net/tcp parsing for environments without iproute2.
  const ss = spawnSync("ss", ["-tlnpH", `sport = :${port}`], { encoding: "utf8" });
  if (ss.status === 0 && ss.stdout) {
    const pids = new Set<number>();
    for (const m of ss.stdout.matchAll(/pid=(\d+)/g)) {
      const v = m[1];
      if (v) pids.add(Number(v));
    }
    return [...pids];
  }
  // Fallback: scan /proc/net/tcp + tcp6 for LISTEN sockets, then walk
  // /proc/*/fd to map the inode back to a pid. Slow but doesn't depend
  // on `ss` being installed.
  return tcpListenersFromProc(port);
}

async function tcpListenersFromProc(port: number): Promise<number[]> {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = await fs.readFile(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const localAddr = parts[1] ?? "";
      const state = parts[3] ?? "";
      if (state !== "0A") continue; // 0A = LISTEN
      if (!localAddr.endsWith(`:${portHex}`)) continue;
      const inode = parts[9];
      if (inode) inodes.add(inode);
    }
  }
  if (inodes.size === 0) return [];
  const all = await allProcesses();
  const pids = new Set<number>();
  await Promise.all(all.map(async (proc) => {
    let fds: string[] = [];
    try { fds = await fs.readdir(`/proc/${proc.pid}/fd`); } catch { return; }
    for (const fd of fds) {
      let link: string;
      try { link = await fs.readlink(`/proc/${proc.pid}/fd/${fd}`); } catch { continue; }
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && m[1] && inodes.has(m[1])) { pids.add(proc.pid); return; }
    }
  }));
  return [...pids];
}

/** Resolve the pid currently listening on a UDS path. */
export async function unixSocketHolder(socketPath: string): Promise<number | null> {
  const real = path.resolve(socketPath);
  const ss = spawnSync("ss", ["-xlpnH"], { encoding: "utf8" });
  if (ss.status === 0 && ss.stdout) {
    for (const line of ss.stdout.split("\n")) {
      if (!line.includes(real)) continue;
      const m = line.match(/pid=(\d+)/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/** True iff the pid is alive (`kill -0`). EPERM still counts as alive. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

/** Count the open fds for a pid. Returns -1 if the pid is gone. */
export async function fdCount(pid: number): Promise<number> {
  try {
    const fds = await fs.readdir(`/proc/${pid}/fd`);
    return fds.length;
  } catch { return -1; }
}

/** Sum the VmRSS of every process matching `predicate`. Returns kB. */
export async function rssOfMatching(predicate: (row: ProcessRow) => boolean): Promise<number> {
  const all = await allProcesses();
  return all.filter(predicate).reduce((sum, p) => sum + p.rss, 0);
}

/** Find processes by command regex. */
export async function processesMatching(regex: RegExp): Promise<ProcessRow[]> {
  const all = await allProcesses();
  return all.filter((p) => regex.test(p.cmd));
}

/** Poll a predicate up to `timeoutMs`, sleeping `pollMs` between calls. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; pollMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 5000, pollMs = 50, label = "predicate" } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

/** Wait until `pid` is reaped (no longer in /proc). */
export async function waitForPidGone(pid: number, timeoutMs = 5000): Promise<void> {
  await waitFor(() => !isAlive(pid), { timeoutMs, label: `pid ${pid} gone` });
}

/** Wait until `port` has zero listeners. */
export async function waitForPortFree(port: number, timeoutMs = 5000): Promise<void> {
  await waitFor(async () => (await tcpListenersOnPort(port)).length === 0, {
    timeoutMs,
    label: `port ${port} free`,
  });
}

/**
 * SIGKILL every descendant of `pid` (and pid itself if `inclusive`). Used
 * by tests to make absolutely sure nothing leaks across runs.
 */
export async function killTree(pid: number, inclusive = true): Promise<void> {
  const pids = await descendantsOf(pid, inclusive);
  for (const p of pids) {
    try { process.kill(p, "SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Spawn an HTTP server on the given port that immediately answers 200.
 * Used by tests that need a placeholder port-holder so they can assert
 * the EADDRINUSE diagnostic on the *real* supervisor.
 */
export function spawnPortHolder(port: number, label = "port-holder"): { child: ReturnType<typeof spawn>; ready: Promise<void> } {
  const script = `
    import http from "node:http";
    const port = ${port};
    const server = http.createServer((_, res) => { res.writeHead(200); res.end(${JSON.stringify(label)}); });
    server.listen(port, "127.0.0.1", () => { process.stdout.write("ready\\n"); });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const ready = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) { child.stdout?.off("data", onData); resolve(); }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`port holder exited code=${code} before ready`)));
    setTimeout(() => reject(new Error("port holder did not become ready in 3s")), 3000);
  });
  return { child, ready };
}

/** Synchronous /proc helper used by static tests and prc-doctor. */
export function listProcessesSync(): ProcessRow[] {
  const out: ProcessRow[] = [];
  let entries: string[];
  try { entries = fsSync.readdirSync("/proc"); } catch { return out; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let stat = "";
    let cmdline = "";
    try {
      stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
      cmdline = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch { continue; }
    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) continue;
    const after = stat.slice(lastParen + 1).trim().split(/\s+/);
    out.push({
      pid,
      ppid: Number(after[1]),
      pgid: Number(after[2]),
      rss: 0, // skip the syscall in sync mode
      startTime: Number(after[18]),
      state: after[0] ?? "?",
      cmd: cmdline.replace(/\0+$/, "").split("\0").join(" ").trim(),
    });
  }
  return out;
}
