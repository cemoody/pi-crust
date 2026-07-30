import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionTimelineMetadataStore } from "../../src/server/session/session-timeline-metadata-store.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeline-metadata-store-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("SessionTimelineMetadataStore", () => {
  it("persists bounded scan results for a fresh store and incrementally observes appended user activity", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(sessionFile, lines(
      { type: "session", timestamp: "2025-01-01T00:00:00.000Z" },
      { type: "message", message: { role: "user", timestamp: "2025-01-01T00:01:00.000Z" } },
      { type: "message", message: { role: "assistant", timestamp: "2025-01-01T00:02:00.000Z" } },
    ));

    const firstStore = new SessionTimelineMetadataStore();
    await expect(firstStore.read(sessionFile)).resolves.toEqual({
      createdAt: Date.parse("2025-01-01T00:00:00.000Z"),
      lastUserActivity: Date.parse("2025-01-01T00:01:00.000Z"),
    });
    await firstStore.flush();

    const secondStore = new SessionTimelineMetadataStore();
    await expect(secondStore.read(sessionFile)).resolves.toEqual({
      createdAt: Date.parse("2025-01-01T00:00:00.000Z"),
      lastUserActivity: Date.parse("2025-01-01T00:01:00.000Z"),
    });

    await fs.appendFile(sessionFile, lines(
      { type: "message", message: { role: "user", timestamp: "2025-01-01T00:03:00.000Z" } },
    ));
    await expect(secondStore.read(sessionFile)).resolves.toEqual({
      createdAt: Date.parse("2025-01-01T00:00:00.000Z"),
      lastUserActivity: Date.parse("2025-01-01T00:03:00.000Z"),
    });
  });

  it("returns empty metadata for missing files and ignores malformed JSONL lines", async () => {
    const store = new SessionTimelineMetadataStore();
    await expect(store.read(path.join(tempDir, "missing.jsonl"))).resolves.toEqual({ createdAt: null, lastUserActivity: null });

    const sessionFile = path.join(tempDir, "malformed.jsonl");
    await fs.writeFile(sessionFile, "not json\n" + lines({ type: "session", timestamp: 42 }));
    await expect(store.read(sessionFile)).resolves.toEqual({ createdAt: 42, lastUserActivity: null });
  });
});

function lines(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
