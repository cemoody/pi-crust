import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Persisted record describing a detached Pi RPC worker (supervisor process).
 * Written atomically by scripts/pirpc-supervisor.mjs at
 * ${runtimeDir}/sessions/${sessionId}.json.
 */
export interface WorkerStatus {
  readonly pid: number;
  readonly sessionId: string;
  readonly socketPath: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly lastSeq: number;
}

export interface WorkerRegistryOptions {
  readonly runtimeDir?: string;
}

export function defaultRuntimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) return path.join(xdg, "pi-crust");
  // macOS's os.tmpdir() is usually a long /var/folders/... path. Unix-domain
  // socket paths are limited (about 104 bytes on macOS), so keep the default
  // runtime root short there.
  if (process.platform === "darwin") return path.join("/tmp", `pi-crust-${process.getuid?.() ?? "user"}`);
  return path.join(os.tmpdir(), "pi-crust");
}

/**
 * Legacy runtime dir candidates from the pre-rename pi-remote-control name.
 * Read for the one-shot migration in {@link migrateLegacyRuntimeDir};
 * removable after one deprecation release.
 */
function legacyRuntimeDirCandidates(): string[] {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const out: string[] = [];
  if (xdg && xdg.length > 0) out.push(path.join(xdg, "pi-remote-control"));
  if (process.platform === "darwin") out.push(path.join("/tmp", `pi-remote-control-${process.getuid?.() ?? "user"}`));
  out.push(path.join(os.tmpdir(), "pi-remote-control"));
  return out;
}

/**
 * One-shot migration: if the new runtime dir doesn't exist yet but a legacy
 * pi-remote-control runtime dir does, rename it into place. Preserves live
 * UNIX-socket connections to detached `pi --mode rpc` workers spawned by the
 * pre-rename release, so on first boot after upgrade the new API can still
 * `reattachAll()` to them.
 *
 * Synchronous and safe to call repeatedly. Returns true iff a migration
 * was performed.
 */
export function migrateLegacyRuntimeDir(
  targetDir: string,
  candidates: readonly string[] = legacyRuntimeDirCandidates(),
): boolean {
  if (fsSync.existsSync(targetDir)) return false;
  for (const legacy of candidates) {
    if (legacy === targetDir) continue;
    if (!fsSync.existsSync(legacy)) continue;
    try {
      fsSync.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
      fsSync.renameSync(legacy, targetDir);
      process.stderr.write(
        `[pi-crust] migrated legacy runtime dir: ${legacy} -> ${targetDir}\n`,
      );
      return true;
    } catch (err) {
      process.stderr.write(
        `[pi-crust] could not migrate legacy runtime dir ${legacy}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return false;
    }
  }
  return false;
}

export class WorkerRegistry {
  readonly runtimeDir: string;
  readonly sessionsDir: string;
  readonly workersDir: string;
  readonly socketDir: string;

  constructor(options: WorkerRegistryOptions = {}) {
    this.runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
    // One-shot legacy-dir migration (pi-remote-control -> pi-crust). Safe
    // to call repeatedly; only acts when the new dir doesn't exist yet.
    migrateLegacyRuntimeDir(this.runtimeDir);
    this.sessionsDir = path.join(this.runtimeDir, "sessions");
    this.workersDir = path.join(this.runtimeDir, "workers");
    this.socketDir = path.join(this.runtimeDir, "s");
  }

  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.workersDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.socketDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Scan the runtime sessions directory and return all status entries whose
   * supervisor pid is still alive. Stale entries (dead pid) are pruned from
   * disk, along with any orphan .sock file.
   */
  async listAlive(): Promise<readonly WorkerStatus[]> {
    await this.ensureDirs();
    const entries = await safeReaddir(this.sessionsDir);
    const alive: WorkerStatus[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.sessionsDir, name);
      let parsed: WorkerStatus | null = null;
      try {
        const text = await fs.readFile(file, "utf8");
        parsed = JSON.parse(text) as WorkerStatus;
      } catch {
        // Corrupt status; remove.
        await safeUnlink(file);
        continue;
      }
      if (!parsed || typeof parsed.pid !== "number" || typeof parsed.sessionId !== "string") {
        await safeUnlink(file);
        continue;
      }
      if (isPidAlive(parsed.pid)) {
        alive.push(parsed);
      } else {
        await safeUnlink(file);
        await safeUnlink(parsed.socketPath);
      }
    }
    return alive;
  }

  statusPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  socketPath(sessionId: string): string {
    return path.join(this.socketDir, socketBasename(sessionId));
  }

  workerReadyPath(workerToken: string): string {
    return path.join(this.workersDir, `${workerToken}.ready`);
  }

  async removeSession(sessionId: string): Promise<void> {
    await safeUnlink(this.statusPath(sessionId));
    await safeUnlink(this.socketPath(sessionId));
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it (still alive).
    if (code === "EPERM") return true;
    return false;
  }
}

export function socketBasename(sessionId: string): string {
  const digest = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `${digest}.sock`;
}

async function safeReaddir(dir: string): Promise<readonly string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function safeUnlink(file: string | undefined): Promise<void> {
  if (!file) return;
  try { await fs.unlink(file); } catch { /* ignore */ }
}
