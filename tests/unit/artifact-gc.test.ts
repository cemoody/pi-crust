import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gcOrphanArtifacts } from "../../src/server/artifact-gc.js";

describe("gcOrphanArtifacts", () => {
  let projectRoot: string;
  let sessionRoot: string;

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-gc-test-"));
    projectRoot = path.join(tmp, "project");
    sessionRoot = path.join(tmp, "sessions");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(sessionRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(projectRoot), { recursive: true, force: true });
  });

  async function makeArtifactDir(sessionId: string, age: { mtimeMs: number }) {
    const dir = path.join(projectRoot, ".pi", "artifacts", sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "x.png"), "stub");
    await fs.utimes(dir, age.mtimeMs / 1000, age.mtimeMs / 1000);
  }

  it("returns zero scanned when the artifacts root does not exist", async () => {
    const result = await gcOrphanArtifacts({ projectRoot, sessionRoot });
    expect(result).toEqual({ scanned: 0, removed: [], skipped: [] });
  });

  it("keeps artifact dirs whose session file still exists", async () => {
    const sessionId = "live-session";
    const now = Date.now();
    await makeArtifactDir(sessionId, { mtimeMs: now - 30 * 24 * 60 * 60 * 1000 });
    await fs.writeFile(path.join(sessionRoot, `${sessionId}.jsonl`), "");
    const result = await gcOrphanArtifacts({ projectRoot, sessionRoot, now: () => now });
    expect(result.removed).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("session-alive");
    expect(await fs.readdir(path.join(projectRoot, ".pi", "artifacts"))).toContain(sessionId);
  });

  it("keeps recently-modified dirs even when the session file is gone", async () => {
    const sessionId = "recent-orphan";
    const now = Date.now();
    await makeArtifactDir(sessionId, { mtimeMs: now - 60_000 });
    const result = await gcOrphanArtifacts({
      projectRoot,
      sessionRoot,
      retentionMs: 24 * 60 * 60 * 1000,
      now: () => now,
    });
    expect(result.removed).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("too-young");
  });

  it("removes orphans older than the retention window", async () => {
    const sessionId = "old-orphan";
    const now = Date.now();
    await makeArtifactDir(sessionId, { mtimeMs: now - 30 * 24 * 60 * 60 * 1000 });
    const result = await gcOrphanArtifacts({
      projectRoot,
      sessionRoot,
      retentionMs: 24 * 60 * 60 * 1000,
      now: () => now,
    });
    expect(result.removed).toEqual([sessionId]);
    expect(await fs.readdir(path.join(projectRoot, ".pi", "artifacts"))).not.toContain(sessionId);
  });

  it("respects dry-run mode", async () => {
    const sessionId = "old-orphan";
    const now = Date.now();
    await makeArtifactDir(sessionId, { mtimeMs: now - 30 * 24 * 60 * 60 * 1000 });
    const result = await gcOrphanArtifacts({
      projectRoot,
      sessionRoot,
      retentionMs: 24 * 60 * 60 * 1000,
      now: () => now,
      dryRun: true,
    });
    expect(result.removed).toEqual([sessionId]);
    expect(await fs.readdir(path.join(projectRoot, ".pi", "artifacts"))).toContain(sessionId);
  });
});
