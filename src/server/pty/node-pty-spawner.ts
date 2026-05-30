/**
 * Real PtySpawner backed by node-pty. Kept in its own module so the unit suite
 * never imports the native addon. The spawner is cwd-confined by a PathPolicy:
 * a pty can only be opened for a directory inside the allowed project roots,
 * mirroring SessionRegistry.assertAllowedCwd.
 *
 * Spec: docs/terminal-wterm-tdd-plan.md contract items 16–20.
 */
import * as os from "node:os";
import { createRequire } from "node:module";
import type { PathPolicy } from "../security/path-policy.js";
import type { PtyChild, PtySpawner, PtySpawnOptions } from "./pty-manager.js";

// node-pty is a native CJS addon; load it via createRequire so this ESM module
// can import it without a top-level `require` (undefined under ESM).
const requireCjs = createRequire(import.meta.url);

export interface NodePtySpawnerOptions {
  readonly pathPolicy: PathPolicy;
  readonly defaultShell?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/bash";
}

export function createNodePtySpawner(options: NodePtySpawnerOptions): PtySpawner {
  return (spawnOptions: PtySpawnOptions): PtyChild => {
    // Confinement happens BEFORE spawn so an out-of-root cwd never starts a
    // shell. assertAllowedCwd throws on violation (rejected at the gateway).
    const cwd = options.pathPolicy.assertAllowedCwd(spawnOptions.cwd);

    // Lazy require so the native addon is only loaded when a real pty is opened.
    const pty = requireCjs("node-pty") as typeof import("node-pty");
    const child = pty.spawn(spawnOptions.shell ?? options.defaultShell ?? defaultShell(), [], {
      name: "xterm-color",
      cols: spawnOptions.cols,
      rows: spawnOptions.rows,
      cwd,
      env: { ...process.env, ...options.env, ...spawnOptions.env, TERM: "xterm-color" } as Record<string, string>,
    });

    return {
      pid: child.pid,
      write: (data: string) => child.write(data),
      resize: (cols: number, rows: number) => child.resize(cols, rows),
      onData: (listener: (data: string) => void) => {
        const sub = child.onData(listener);
        return () => sub.dispose();
      },
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        const sub = child.onExit(({ exitCode, signal }) => listener(signal === undefined ? { exitCode } : { exitCode, signal }));
        return () => sub.dispose();
      },
      kill: (signal?: string) => {
        try { child.kill(signal); } catch { /* already dead */ }
      },
    };
  };
}

export { os };
