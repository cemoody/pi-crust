import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * Filesystem path → MIME, for files served via /api/artifact-file. We allow
 * a broader set than the WUI static fallback because artifact-file is
 * intended for arbitrary user-generated content (plots, PDFs, mp4s).
 */
const ARTIFACT_FILE_MIME: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".bmp":  "image/bmp",
  ".avif": "image/avif",
  ".pdf":  "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".csv":  "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md":   "text/markdown; charset=utf-8",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
  ".mov":  "video/quicktime",
};

export interface ArtifactFileResolution {
  readonly absPath: string;
  readonly realPath: string;
  readonly size: number;
  readonly mimeType: string;
}

export interface ArtifactFileError {
  readonly status: 400 | 403 | 404;
  readonly error: string;
}

export interface ResolveArtifactFileOptions {
  /**
   * Roots inside which an artifact file is allowed to live. The resolved
   * (realpath'd) candidate must be inside at least one of these directories.
   * Each root is itself realpath'd before comparison so symlinked tmpdirs
   * (e.g. /tmp -> /private/tmp on macOS) Just Work.
   */
  readonly allowedRoots: readonly string[];
}

/**
 * Default allow-list roots used by both the tool-side validator (before
 * emitting an artifact url) and the backend route. We intentionally keep the
 * list narrow: places where it's normal for an agent to drop generated files.
 *
 * - OS tmpdir (e.g. /tmp) — the canonical scratch space
 * - $HOME — covers project worktrees and ~/Downloads etc. on the user's
 *   own machine. PRC is a single-user dev server, so this is the same
 *   trust boundary the agent already operates inside.
 *
 * We deliberately do NOT include `/` or unrelated system paths. Path
 * traversal is blocked by realpath + root containment check, so even a
 * symlink under $HOME that points at /etc/shadow won't be served.
 */
export function defaultArtifactFileRoots(extra: readonly string[] = []): string[] {
  const roots = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    try {
      roots.add(path.resolve(value));
    } catch {
      // ignore unresolvable values
    }
  };
  add(os.tmpdir());
  add(os.homedir());
  for (const value of extra) add(value);
  return [...roots];
}

/**
 * Resolve and validate a filesystem path supplied as untrusted input to the
 * /api/artifact-file endpoint or the show_artifact tool. Returns either
 * { ok: true, ... } with stat/mime info, or { ok: false, status, error }.
 *
 * The check uses fs.realpath so symlink escapes are blocked: the final
 * realpath must live inside one of `allowedRoots` (each also realpath'd).
 */
export async function resolveArtifactFile(
  candidatePath: string,
  options: ResolveArtifactFileOptions,
): Promise<{ ok: true; resolution: ArtifactFileResolution } | { ok: false } & ArtifactFileError> {
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    return { ok: false, status: 400, error: "path is required" };
  }
  if (candidatePath.includes("\0")) {
    return { ok: false, status: 400, error: "path must not contain NUL bytes" };
  }

  // Resolve relative paths against process.cwd() at validation time. Callers
  // that need a different base (e.g. session cwd) should pass an absolute
  // path; the tool-side wrapper does exactly that.
  const absPath = path.resolve(candidatePath);

  let realPath: string;
  let stat: fs.Stats;
  try {
    realPath = await fsp.realpath(absPath);
    stat = await fsp.stat(realPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, status: 404, error: `file not found: ${candidatePath}` };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, status: 403, error: `permission denied: ${candidatePath}` };
    }
    return { ok: false, status: 404, error: `file not readable: ${candidatePath}` };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 404, error: `not a regular file: ${candidatePath}` };
  }

  const realRoots = await resolveRealRoots(options.allowedRoots);
  if (!isWithinAnyRoot(realPath, realRoots)) {
    return {
      ok: false,
      status: 403,
      error: `path is outside the allow-list (tmpdir, home). Got: ${candidatePath}`,
    };
  }

  const ext = path.extname(realPath).toLowerCase();
  const mimeType = ARTIFACT_FILE_MIME[ext] ?? "application/octet-stream";
  return {
    ok: true,
    resolution: { absPath, realPath, size: stat.size, mimeType },
  };
}

async function resolveRealRoots(roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(await fsp.realpath(root));
    } catch {
      // Skip roots that don't exist on disk; e.g. a misconfigured projectRoot.
    }
  }
  return out;
}

function isWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (candidate === root) return true;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (candidate.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Stream a resolved artifact file as the HTTP response. Sets Content-Type,
 * Content-Length, and a cache header tuned for short-lived agent output.
 */
export async function streamArtifactFile(
  resolution: ArtifactFileResolution,
  res: http.ServerResponse,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", resolution.mimeType);
  res.setHeader("Content-Length", String(resolution.size));
  // Short cache: artifact files often get overwritten by re-runs. ETag from
  // node's http impl is fine for now; we don't set one explicitly because
  // we have no inode-stable id.
  res.setHeader("Cache-Control", "private, max-age=60");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(resolution.realPath);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}

/**
 * URL-safe path encoded for use as the value of the `?path=` query parameter
 * on /api/artifact-file. Centralized so the tool and the backend agree on
 * exactly how paths are serialized.
 */
export function encodeArtifactFilePath(absPath: string): string {
  return encodeURIComponent(absPath);
}
