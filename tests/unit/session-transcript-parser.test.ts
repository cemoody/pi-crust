import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionTranscript } from "../../src/server/session/session-transcript-parser.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("parseSessionTranscript", () => {
  it("distills supported JSONL events into bounded, searchable transcript fields", async () => {
    const filename = await writeTranscript([
      { type: "session", id: "parser-session", cwd: "/work/parser", timestamp: "2026-07-01T00:00:00.000Z", subagent: true, hiddenFromList: true },
      "not valid json",
      { type: "session_info", name: "  Parser focus  " },
      { type: "message", id: "u1", timestamp: 10, message: { role: "user", timestamp: 11, content: [{ type: "text", text: "Find the durable parser boundary" }] } },
      { type: "compaction", id: "summary", timestamp: 12, summary: "Preserve malformed-line tolerance." },
      { type: "custom_message", id: "custom", timestamp: 13, content: "Custom searchable note" },
      { type: "message", id: "tool", timestamp: 14, message: { role: "toolResult", content: [{ type: "text", text: "must not be indexed" }] } },
    ]);

    await expect(parseSessionTranscript(filename)).resolves.toEqual(expect.objectContaining({
      sessionId: "parser-session",
      cwd: "/work/parser",
      sessionName: "Parser focus",
      subagent: true,
      hiddenFromList: true,
      firstPrompt: "Find the durable parser boundary",
      summaries: "Preserve malformed-line tolerance.",
      lastUserActivity: 11_000,
      lastActivity: 11_000,
      chunks: expect.arrayContaining([
        expect.objectContaining({ entryId: "u1", role: "user", timestamp: 11_000, text: "Find the durable parser boundary" }),
        expect.objectContaining({ entryId: "summary", role: "summary", text: "Preserve malformed-line tolerance." }),
        expect.objectContaining({ entryId: "custom", role: "custom", text: "Custom searchable note" }),
      ]),
    }));
  });

  it("rejects metadata-free transcripts", async () => {
    const filename = await writeTranscript([{ type: "message", message: { role: "user", content: "orphaned content" } }]);

    await expect(parseSessionTranscript(filename)).resolves.toBeUndefined();
  });
});

async function writeTranscript(entries: readonly unknown[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-transcript-parser-"));
  roots.push(root);
  const filename = path.join(root, "session.jsonl");
  await fs.writeFile(filename, entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n");
  return filename;
}
