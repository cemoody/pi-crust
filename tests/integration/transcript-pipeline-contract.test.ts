import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNormalizedTranscriptMessages,
  persistOversizedTranscriptBodies,
} from "../../src/server/pi/transcripts/index.js";
import { readSessionMessagesTail } from "../../src/server/session/transcript-tail-reader.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("transcript pipeline contract", () => {
  it("gives adapter and JSONL-tail readers one hydrated, normalized timeline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-transcript-contract-"));
    roots.push(root);
    const sessionFile = path.join(root, "contract.jsonl");
    const artifactHtml = `<main>${"artifact body ".repeat(8_000)}</main>`;
    const rawMessages = [
      {
        role: "assistant",
        timestamp: 1_000,
        content: [
          { type: "thinking", thinking: "Inspect the artifact." },
          { type: "text", text: "I created the artifact." },
          { type: "toolCall", id: "artifact-1", name: "show_artifact", arguments: { title: "Report" } },
        ],
      },
      {
        role: "toolResult",
        timestamp: 2_000,
        toolCallId: "artifact-1",
        isError: false,
        content: [{ type: "text", text: "Artifact displayed." }],
        details: { piRemoteControlArtifact: { kind: "html", title: "Report", html: artifactHtml } },
      },
      {
        role: "custom",
        customType: "todo",
        timestamp: 3_000,
        content: "Queued a follow-up.",
        details: { items: [{ content: "Review report", state: "open" }] },
      },
    ];
    const entries = [
      { type: "session", id: "contract", cwd: root, timestamp: new Date(500).toISOString() },
      ...rawMessages.map((message, index) => ({
        type: "message",
        id: `message-${index}`,
        timestamp: new Date(message.timestamp).toISOString(),
        message,
      })),
    ];
    await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const compacted = await persistOversizedTranscriptBodies(sessionFile);
    const persistedRawMessages = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: unknown })
      .flatMap((entry) => entry.message === undefined ? [] : [entry.message]);
    // This is the shape both SDK-reopen and RPC get_messages hand to the
    // shared adapter boundary after persistence has replaced an artifact with
    // its sidecar reference.
    const adapterTimeline = await loadNormalizedTranscriptMessages(sessionFile, persistedRawMessages);
    const tailTimeline = await readSessionMessagesTail(sessionFile, { limit: 10 });

    expect(compacted).toMatchObject({ rewrittenRows: 1 });
    expect(adapterTimeline).toEqual([
      {
        role: "assistant",
        content: "I created the artifact.",
        thinking: "Inspect the artifact.",
        timestamp: 1_000,
      },
      {
        role: "tool",
        content: "Artifact displayed.",
        timestamp: 2_000,
        tool: expect.objectContaining({
          id: "artifact-1",
          name: "show_artifact",
          status: "success",
          output: "Artifact displayed.",
          artifact: { kind: "html", title: "Report", html: artifactHtml },
        }),
      },
      {
        role: "custom",
        customType: "todo",
        content: "Queued a follow-up.",
        timestamp: 3_000,
        details: { items: [{ content: "Review report", state: "open" }] },
      },
    ]);
    expect(tailTimeline).toEqual(adapterTimeline);
  });
});
