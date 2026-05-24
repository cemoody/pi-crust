/**
 * TDD characterization tests for the head+tail jsonl scanner being lifted
 * out of pirpc-pi-adapter.ts. Each test synthesizes a tiny .jsonl file in
 * a tmpdir and exercises one branch of fastListSessions /
 * parseScannedSession that the existing e2e regression suite doesn't reach.
 *
 * Written before the extraction; initially passes against the current
 * pirpc-pi-adapter export, will continue to pass after the move to
 * src/server/pi/session-jsonl-scanner.ts.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fastListSessions } from "../../src/server/pi/pirpc-pi-adapter.js";

let tmp: string;
const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-scan-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("fastListSessions", () => {
  it("returns [] for an undefined sessionDir without throwing", async () => {
    expect(await fastListSessions(undefined)).toEqual([]);
  });

  it("returns [] for a non-existent sessionDir without throwing", async () => {
    expect(await fastListSessions(path.join(tmp, "does-not-exist"))).toEqual([]);
  });

  it("returns [] for a directory with no .jsonl files", async () => {
    await fs.writeFile(path.join(tmp, "not-a-session.txt"), "ignored");
    expect(await fastListSessions(tmp)).toEqual([]);
  });

  it("parses a session header, picks createdAt from its timestamp, and falls back to mtime for lastActivity when only the header is present", async () => {
    const file = path.join(tmp, "s1.jsonl");
    await fs.writeFile(file, lines(
      { type: "session", id: "s1", cwd: "/work", timestamp: 1_700_000_000_000 },
    ));
    const result = await fastListSessions(tmp);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("s1");
    expect(result[0]!.cwd).toBe("/work");
    expect(result[0]!.createdAt).toBe(1_700_000_000_000);
    // Header-only file: lastActivity falls back to the file's mtime.
    expect(result[0]!.lastActivity).toBeGreaterThan(0);
  });

  it("skips files with no session header", async () => {
    await fs.writeFile(path.join(tmp, "no-header.jsonl"), lines(
      { type: "message", message: { role: "user", content: "hi" } },
    ));
    expect(await fastListSessions(tmp)).toEqual([]);
  });

  it("uses the LATEST session_info rename for sessionName", async () => {
    const file = path.join(tmp, "s2.jsonl");
    await fs.writeFile(file, lines(
      { type: "session", id: "s2", cwd: "/w", timestamp: 1 },
      { type: "session_info", name: "first" },
      { type: "session_info", name: "second" },
      { type: "session_info", name: "third" },
    ));
    const [row] = await fastListSessions(tmp);
    expect(row!.sessionName).toBe("third");
  });

  it("treats an empty/whitespace session_info name as 'no name'", async () => {
    const file = path.join(tmp, "s3.jsonl");
    await fs.writeFile(file, lines(
      { type: "session", id: "s3", cwd: "/w", timestamp: 1 },
      { type: "session_info", name: "named" },
      { type: "session_info", name: "  " },
    ));
    const [row] = await fastListSessions(tmp);
    expect(row!.sessionName).toBeUndefined();
  });

  it("extracts firstMessage from the first user message (text content)", async () => {
    const file = path.join(tmp, "s4.jsonl");
    await fs.writeFile(file, lines(
      { type: "session", id: "s4", cwd: "/w", timestamp: 1 },
      { type: "message", message: { role: "assistant", content: "ignored", timestamp: 2 } },
      { type: "message", message: { role: "user", content: "first user prompt", timestamp: 3 } },
      { type: "message", message: { role: "user", content: "second prompt", timestamp: 4 } },
    ));
    const [row] = await fastListSessions(tmp);
    expect(row!.firstMessage).toBe("first user prompt");
  });

  it("extracts firstMessage from a structured-content array (type:'text')", async () => {
    const file = path.join(tmp, "s5.jsonl");
    await fs.writeFile(file, lines(
      { type: "session", id: "s5", cwd: "/w", timestamp: 1 },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "structured prompt" }, { type: "image", data: "..." }],
          timestamp: 2,
        },
      },
    ));
    const [row] = await fastListSessions(tmp);
    expect(row!.firstMessage).toBe("structured prompt");
  });

  it("truncates firstMessage to 240 chars", async () => {
    const file = path.join(tmp, "s6.jsonl");
    const long = "x".repeat(500);
    await fs.writeFile(file, lines(
      { type: "session", id: "s6", cwd: "/w", timestamp: 1 },
      { type: "message", message: { role: "user", content: long, timestamp: 2 } },
    ));
    const [row] = await fastListSessions(tmp);
    expect(row!.firstMessage).toHaveLength(240);
  });

  it("sorts results by lastActivity descending", async () => {
    await fs.writeFile(path.join(tmp, "a.jsonl"), lines(
      { type: "session", id: "a", cwd: "/w", timestamp: 1 },
      { type: "message", message: { role: "user", content: "hi", timestamp: 100 } },
    ));
    await fs.writeFile(path.join(tmp, "b.jsonl"), lines(
      { type: "session", id: "b", cwd: "/w", timestamp: 1 },
      { type: "message", message: { role: "user", content: "hi", timestamp: 200 } },
    ));
    await fs.writeFile(path.join(tmp, "c.jsonl"), lines(
      { type: "session", id: "c", cwd: "/w", timestamp: 1 },
      { type: "message", message: { role: "user", content: "hi", timestamp: 50 } },
    ));
    const result = await fastListSessions(tmp);
    expect(result.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("tolerates malformed JSON lines (silently skips them)", async () => {
    const file = path.join(tmp, "s7.jsonl");
    await fs.writeFile(file, [
      JSON.stringify({ type: "session", id: "s7", cwd: "/w", timestamp: 1 }),
      "{not json",
      "",
      JSON.stringify({ type: "message", message: { role: "user", content: "ok", timestamp: 2 } }),
    ].join("\n") + "\n");
    const result = await fastListSessions(tmp);
    expect(result).toHaveLength(1);
    expect(result[0]!.firstMessage).toBe("ok");
  });
});
