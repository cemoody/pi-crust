/**
 * Thin harness for spawning scripts/dev-api.mjs in tests. Centralizes the
 * "spawn, capture stdout+stderr, wait for log shape" pattern so individual
 * tests stay declarative.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "dev-api.mjs");

export interface SupervisorHandle {
  proc: ChildProcess;
  log(): string;
  waitForLog(predicate: (log: string) => boolean, timeoutMs?: number): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SpawnSupervisorOptions {
  /** argv to pass after `--`. */
  cmd: string[];
  /** Override projectRoot for the supervisor. Defaults to pi-crust repo root. */
  cwd?: string;
  /** Override scriptPath (rare: tests that copy the script into a sandbox). */
  scriptPath?: string;
  /** Environment overrides. Common: DEV_API_DEBOUNCE_MS, DEV_API_RESTART_MS. */
  env?: Record<string, string>;
}

export function spawnDevApi(opts: SpawnSupervisorOptions): SupervisorHandle {
  const chunks: string[] = [];
  const proc = spawn(process.execPath, [
    opts.scriptPath ?? SCRIPT,
    "--",
    ...opts.cmd,
  ], {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (c) => chunks.push(c.toString()));
  proc.stderr?.on("data", (c) => chunks.push(c.toString()));
  const log = () => chunks.join("");
  const waitForLog = async (predicate: (log: string) => boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(log())) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`waitForLog timed out after ${timeoutMs}ms. Saw:\n${log()}`);
  };
  const shutdown = async (): Promise<void> => {
    if (!proc.killed) {
      proc.kill("SIGKILL");
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
  };
  return { proc, log, waitForLog, shutdown };
}
