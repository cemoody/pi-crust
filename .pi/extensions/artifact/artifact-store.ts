/**
 * ArtifactStore — content-addressed on-disk store for rich artifacts.
 *
 * Layout: <cwd>/.pi/artifacts/<sessionId>/<artifactId>.<ext>
 *
 * - `sessionId` comes from the session file basename (without `.jsonl`) so the
 *   server can deterministically map a session id to its artifact directory
 *   without consulting the extension at request time.
 * - `artifactId` is the first 16 hex chars of sha256(bytes) so duplicate files
 *   dedupe automatically and fixtures are stable.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { extensionForMime } from "../../../src/shared/artifact.js";

export interface StoredArtifact {
  readonly artifactId: string;
  readonly mime: string;
  readonly diskPath: string;
  readonly relativeUrl: string;
  readonly bytes: number;
}

export interface ArtifactStoreOptions {
  readonly cwd: string;
  readonly sessionId: string;
  /** Max size per artifact in bytes. Default 25 MiB. */
  readonly maxBytes?: number;
  /** Override artifacts root. Defaults to `<cwd>/.pi/artifacts`. */
  readonly artifactsRoot?: string;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export class ArtifactStoreError extends Error {
  constructor(message: string, readonly code: "size_cap" | "path_escape" | "io_error") {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export class ArtifactStore {
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly maxBytes: number;
  private readonly root: string;

  constructor(options: ArtifactStoreOptions) {
    if (!options.cwd) throw new Error("ArtifactStore: cwd is required");
    if (!options.sessionId) throw new Error("ArtifactStore: sessionId is required");
    this.cwd = path.resolve(options.cwd);
    this.sessionId = options.sessionId;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.root = path.resolve(options.artifactsRoot ?? path.join(this.cwd, ".pi", "artifacts"));
  }

  /** Resolve and create the per-session artifact directory. */
  async sessionDir(): Promise<string> {
    const dir = path.join(this.root, this.sessionId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Materialize bytes (or a source path) into the store and return its metadata. */
  async put(input: { mime: string } & ({ bytes: Buffer } | { sourcePath: string })): Promise<StoredArtifact> {
    let bytes: Buffer;
    if ("bytes" in input) {
      bytes = input.bytes;
    } else {
      const resolved = await this.safeResolveSource(input.sourcePath);
      bytes = await fs.readFile(resolved);
    }

    if (bytes.length > this.maxBytes) {
      throw new ArtifactStoreError(
        `Artifact is ${bytes.length} bytes; the per-artifact cap is ${this.maxBytes} bytes`,
        "size_cap",
      );
    }

    const artifactId = sha256Hex(bytes).slice(0, 16);
    const ext = extensionForMime(input.mime);
    const filename = `${artifactId}.${ext}`;
    const dir = await this.sessionDir();
    const diskPath = path.join(dir, filename);
    try {
      // Skip rewrite if identical file already exists (content-addressed).
      const stat = await fs.stat(diskPath).catch(() => undefined);
      if (!stat || stat.size !== bytes.length) {
        await fs.writeFile(diskPath, bytes);
      }
    } catch (error) {
      throw new ArtifactStoreError(
        `Failed to write artifact: ${error instanceof Error ? error.message : String(error)}`,
        "io_error",
      );
    }

    return {
      artifactId,
      mime: input.mime,
      diskPath,
      relativeUrl: `/api/sessions/${encodeURIComponent(this.sessionId)}/artifacts/${encodeURIComponent(filename)}`,
      bytes: bytes.length,
    };
  }

  /**
   * Resolve a source path safely: it must live under the session cwd to prevent
   * the LLM from reading arbitrary host paths through this tool.
   */
  private async safeResolveSource(sourcePath: string): Promise<string> {
    const absolute = path.resolve(this.cwd, sourcePath);
    const real = await fs.realpath(absolute).catch(() => absolute);
    const realCwd = await fs.realpath(this.cwd).catch(() => this.cwd);
    const rel = path.relative(realCwd, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ArtifactStoreError(
        `Refusing to read artifact outside the project root: ${sourcePath}`,
        "path_escape",
      );
    }
    return real;
  }
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
