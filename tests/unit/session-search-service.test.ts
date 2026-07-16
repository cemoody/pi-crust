import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionSearchService } from "../../src/server/session/session-search-service.js";

let root: string;
let sessions: string;
let service: SessionSearchService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-session-search-"));
  sessions = path.join(root, "sessions");
  await fs.mkdir(sessions);
  service = new SessionSearchService({ sessionRoot: sessions, databasePath: path.join(root, "search.sqlite") });
});

afterEach(async () => {
  service.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("SessionSearchService", () => {
  it("searches transcript text and returns a contextual chunk", async () => {
    await writeSession("alpha", [
      header("alpha", "/work/a"),
      message("u1", "user", "Please investigate the ExternalSecret reconciliation failure", 100),
      message("a1", "assistant", "The controller logs point to a missing Vault token.", 101),
    ]);

    const results = await service.search("ExternalSecret failure");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sessionId: "alpha", cwd: "/work/a" });
    expect(results[0]!.matches[0]).toMatchObject({ entryId: "u1", role: "user" });
    expect(results[0]!.matches[0]!.snippet).toContain("<mark>ExternalSecret</mark>");
  });

  it("boosts an explicit session title above a body-only match", async () => {
    await writeSession("named", [
      header("named", "/work/a"),
      { type: "session_info", name: "Kubernetes migration plan" },
      message("u1", "user", "A short unrelated conversation", 100),
    ]);
    await writeSession("body", [
      header("body", "/work/a"),
      message("u2", "user", "We mentioned Kubernetes once in a long body", 100),
    ]);

    const results = await service.search("Kubernetes");

    expect(results.map((result) => result.sessionId)).toEqual(["named", "body"]);
  });

  it("uses the latest session title and incrementally replaces a changed transcript", async () => {
    const filename = await writeSession("rename", [
      header("rename", "/work/a"),
      { type: "session_info", name: "Old title" },
      { type: "session_info", name: "New title" },
      message("u1", "user", "first searchable topic", 100),
    ]);
    expect((await service.search("New title"))[0]?.sessionName).toBe("New title");

    await fs.appendFile(filename, JSON.stringify(message("u2", "assistant", "second searchable topic", 200)) + "\n");
    const results = await service.search("second topic");
    expect(results[0]).toMatchObject({ sessionId: "rename" });
  });

  it("defers an active session until the agent has settled", async () => {
    const filename = await writeSession("live", [
      header("live", "/work/a"),
      message("u1", "user", "A finished answer must not leak partial drafts", 100),
    ]);
    service.markSessionActive(filename);
    expect(await service.search("partial drafts")).toEqual([]);

    service.markSessionSettled(filename);
    await service.sync();
    expect((await service.search("partial drafts"))[0]?.sessionId).toBe("live");
  });

  it("caps custom-message text consistently in session and chunk indexes", async () => {
    await writeSession("custom", [
      header("custom", "/work/a"),
      { type: "custom_message", id: "large", timestamp: 100, content: "x".repeat(2_000_000) + " unique-tail-term", display: true },
    ]);
    expect(await service.search("unique-tail-term")).toEqual([]);
  });

  it("keeps hidden subagent sessions out of default results", async () => {
    await writeSession("child", [{ ...header("child", "/work/a"), subagent: true, hiddenFromList: true }, message("u1", "user", "subagent-only finding", 100)]);
    expect(await service.search("subagent-only finding")).toEqual([]);
    expect((await service.search("subagent-only finding", { includeSubagents: true, includeHidden: true }))[0]?.sessionId).toBe("child");
  });

  it("does not retain sessions excluded by the host policy", async () => {
    service.close();
    service = new SessionSearchService({
      sessionRoot: sessions,
      databasePath: path.join(root, "filtered.sqlite"),
      includeSession: (cwd) => cwd !== "/private",
    });
    await writeSession("private", [header("private", "/private"), message("u1", "user", "never searchable", 100)]);
    await writeSession("public", [header("public", "/work/a"), message("u2", "user", "always searchable", 100)]);
    expect(await service.search("searchable")).toHaveLength(1);
    expect(await service.search("never searchable")).toEqual([]);
  });

  it("indexes compaction summaries but excludes tool result content", async () => {
    await writeSession("scoped", [
      header("scoped", "/work/a"),
      { type: "compaction", id: "c1", timestamp: "2026-07-01T00:00:00.000Z", summary: "Decided on a SQLite FTS5 index." },
      { type: "message", id: "tool", timestamp: "2026-07-01T00:00:01.000Z", message: { role: "toolResult", content: [{ type: "text", text: "ultra-rare-tool-output" }] } },
    ]);

    expect((await service.search("SQLite FTS5"))[0]?.sessionId).toBe("scoped");
    expect(await service.search("ultra-rare-tool-output")).toEqual([]);
  });
});

async function writeSession(id: string, entries: readonly unknown[]): Promise<string> {
  const filename = path.join(sessions, `${id}.jsonl`);
  await fs.writeFile(filename, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return filename;
}

function header(id: string, cwd: string) {
  return { type: "session", version: 3, id, cwd, timestamp: "2026-07-01T00:00:00.000Z" };
}

function message(id: string, role: "user" | "assistant", text: string, timestamp: number) {
  return { type: "message", id, timestamp, message: { role, content: [{ type: "text", text }], timestamp } };
}
