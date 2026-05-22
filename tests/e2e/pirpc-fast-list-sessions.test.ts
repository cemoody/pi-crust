/**
 * Regression spec for the bug that forced the revert in #106.
 *
 * The first cut of fastListSessions() filtered out any session whose
 * `header.cwd` did not match the cwd query parameter on /api/sessions. That
 * diverged from the historical pi SDK behaviour (SessionManager.list()
 * scans the configured flat sessionDir and returns EVERY .jsonl in it,
 * regardless of which cwd those sessions were created from), which made
 * recent sessions created in child worktrees disappear from the sidebar.
 *
 * These tests pin the contract down: the flat-sessionDir lister must
 * return every session in the directory, in newest-first order, and
 * tolerate sessions whose header.cwd is anywhere on the filesystem.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fastListSessions } from "../../src/server/pi/pirpc-pi-adapter.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("pirpc fastListSessions", () => {
  it("returns sessions whose header.cwd differs from the requested cwd", async () => {
    const dir = await mkSessionDir();
    await writeSession(dir, "session-home", { cwd: "/home/coder", createdAt: 1_700_000_000_000 });
    await writeSession(dir, "session-worktree-a", { cwd: "/home/coder/code/wt-a", createdAt: 1_700_000_100_000 });
    await writeSession(dir, "session-worktree-b", { cwd: "/home/coder/code/wt-b", createdAt: 1_700_000_200_000 });

    const sessions = await fastListSessions(dir, "/home/coder");
    const ids = sessions.map((session) => session.id).sort();
    // The historical SDK returned ALL three; the filter bug returned only the
    // one whose cwd exactly matched the request. This is the test that #106
    // would have caught.
    expect(ids).toEqual(["session-home", "session-worktree-a", "session-worktree-b"]);
  });

  it("sorts by lastActivity descending, newest first", async () => {
    const dir = await mkSessionDir();
    await writeSession(dir, "oldest", { cwd: "/home/coder", createdAt: 1_700_000_000_000, lastUserActivity: 1_700_000_000_500 });
    await writeSession(dir, "newest", { cwd: "/home/coder/code/wt", createdAt: 1_700_000_200_000, lastUserActivity: 1_700_000_999_000 });
    await writeSession(dir, "middle", { cwd: "/home/coder", createdAt: 1_700_000_100_000, lastUserActivity: 1_700_000_500_000 });

    const sessions = await fastListSessions(dir, "/home/coder");
    expect(sessions.map((session) => session.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("extracts sessionName from session_info entries near the top of the file", async () => {
    const dir = await mkSessionDir();
    await writeSession(dir, "named", {
      cwd: "/home/coder",
      createdAt: 1_700_000_000_000,
      sessionName: "important task",
    });
    const sessions = await fastListSessions(dir, "/home/coder");
    const named = sessions.find((session) => session.id === "named");
    expect(named?.sessionName).toBe("important task");
  });

  it("returns sessions even when no cwd is provided", async () => {
    const dir = await mkSessionDir();
    await writeSession(dir, "any-1", { cwd: "/wherever", createdAt: 1_700_000_000_000 });
    await writeSession(dir, "any-2", { cwd: "/elsewhere", createdAt: 1_700_000_100_000 });
    const sessions = await fastListSessions(dir, undefined);
    expect(sessions.map((session) => session.id).sort()).toEqual(["any-1", "any-2"]);
  });

  it("returns a brand-new session with only a header line (no messages yet)", async () => {
    const dir = await mkSessionDir();
    await writeSession(dir, "freshly-created", { cwd: "/home/coder", createdAt: 1_700_000_555_000 });
    const sessions = await fastListSessions(dir, "/home/coder");
    const created = sessions.find((session) => session.id === "freshly-created");
    expect(created).toBeDefined();
    expect(created?.lastActivity).toBe(1_700_000_555_000);
  });
});

async function mkSessionDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fast-list-"));
  tempDirs.push(dir);
  return dir;
}

interface WriteOptions {
  readonly cwd: string;
  readonly createdAt: number;
  readonly lastUserActivity?: number;
  readonly sessionName?: string;
}

async function writeSession(dir: string, id: string, options: WriteOptions): Promise<void> {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "session", id, cwd: options.cwd, timestamp: new Date(options.createdAt).toISOString() }));
  if (options.sessionName) {
    lines.push(JSON.stringify({ type: "session_info", name: options.sessionName, timestamp: new Date(options.createdAt + 1).toISOString() }));
  }
  if (options.lastUserActivity !== undefined) {
    lines.push(JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: new Date(options.lastUserActivity).toISOString() } }));
  }
  await fs.writeFile(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
}
