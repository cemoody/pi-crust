import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactStore, ArtifactStoreError } from "../../.pi/extensions/artifact/artifact-store.js";

describe("ArtifactStore", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-store-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes bytes under <cwd>/.pi/artifacts/<sessionId>/ and returns a stable id", async () => {
    const store = new ArtifactStore({ cwd: tmpRoot, sessionId: "abc123" });
    const stored = await store.put({ mime: "image/png", bytes: Buffer.from("fake-png") });
    expect(stored.diskPath).toBe(path.join(tmpRoot, ".pi", "artifacts", "abc123", `${stored.artifactId}.png`));
    expect(stored.artifactId).toHaveLength(16);
    expect(stored.relativeUrl).toBe(`/api/sessions/abc123/artifacts/${stored.artifactId}.png`);
    expect((await fs.readFile(stored.diskPath)).toString()).toBe("fake-png");
  });

  it("produces identical artifact ids for identical content (dedupe)", async () => {
    const store = new ArtifactStore({ cwd: tmpRoot, sessionId: "s1" });
    const a = await store.put({ mime: "image/png", bytes: Buffer.from("same") });
    const b = await store.put({ mime: "image/png", bytes: Buffer.from("same") });
    expect(a.artifactId).toBe(b.artifactId);
    expect(a.diskPath).toBe(b.diskPath);
  });

  it("enforces the per-artifact size cap", async () => {
    const store = new ArtifactStore({ cwd: tmpRoot, sessionId: "s1", maxBytes: 16 });
    await expect(
      store.put({ mime: "image/png", bytes: Buffer.alloc(64) }),
    ).rejects.toMatchObject({ code: "size_cap" });
  });

  it("rejects source paths outside the cwd", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-store-outside-"));
    try {
      const evil = path.join(outside, "secret.png");
      await fs.writeFile(evil, "secret-bytes");
      const store = new ArtifactStore({ cwd: tmpRoot, sessionId: "s1" });
      await expect(
        store.put({ mime: "image/png", sourcePath: evil }),
      ).rejects.toBeInstanceOf(ArtifactStoreError);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("accepts a source path inside the cwd", async () => {
    const inside = path.join(tmpRoot, "plots", "chart.png");
    await fs.mkdir(path.dirname(inside), { recursive: true });
    await fs.writeFile(inside, "chart-bytes");
    const store = new ArtifactStore({ cwd: tmpRoot, sessionId: "s1" });
    const stored = await store.put({ mime: "image/png", sourcePath: inside });
    expect((await fs.readFile(stored.diskPath)).toString()).toBe("chart-bytes");
  });
});
