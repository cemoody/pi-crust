import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CronStore } from "../../src/server/cron/cron-store.js";

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cron-store-"));
  const file = path.join(dir, "cron-jobs.json");
  return { dir, file, store: new CronStore(file) };
}

describe("CronStore", () => {
  it("returns empty list when the file does not exist", async () => {
    const { store } = await makeStore();
    expect(await store.list()).toEqual([]);
  });

  it("creates jobs and persists them to disk", async () => {
    const { store, file } = await makeStore();
    const created = await store.create({ name: "Nightly", schedule: "0 0 * * *", prompt: "summarize the day", cwd: "/tmp" });
    expect(created.id).toMatch(/[0-9a-f-]+/);
    expect(created.enabled).toBe(true);

    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(raw.jobs).toHaveLength(1);
    expect(raw.jobs[0].name).toBe("Nightly");
  });

  it("reloads persisted jobs from disk", async () => {
    const { file, store } = await makeStore();
    await store.create({ name: "A", schedule: "* * * * *", prompt: "p", cwd: "/tmp" });
    const reopened = new CronStore(file);
    const jobs = await reopened.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe("A");
  });

  it("updates patches without clobbering other fields", async () => {
    const { store } = await makeStore();
    const created = await store.create({ name: "A", schedule: "* * * * *", prompt: "p", cwd: "/tmp" });
    const updated = await store.update(created.id, { enabled: false, lastRun: 12345 });
    expect(updated?.name).toBe("A");
    expect(updated?.enabled).toBe(false);
    expect(updated?.lastRun).toBe(12345);
    expect(updated?.prompt).toBe("p");
  });

  it("clears optional metadata fields when patches explicitly set them to undefined", async () => {
    const { store } = await makeStore();
    const created = await store.create({ name: "A", schedule: "* * * * *", prompt: "p", cwd: "/tmp" });
    await store.update(created.id, { lastRun: 123, nextRun: 456, lastSessionId: "sid-1" });

    const updated = await store.update(created.id, { lastRun: undefined, nextRun: undefined, lastSessionId: undefined });

    expect(updated).not.toHaveProperty("lastRun");
    expect(updated).not.toHaveProperty("nextRun");
    expect(updated).not.toHaveProperty("lastSessionId");
    const persisted = JSON.parse(await fs.readFile(store.filePath, "utf8"));
    expect(persisted.jobs[0]).not.toHaveProperty("lastRun");
    expect(persisted.jobs[0]).not.toHaveProperty("nextRun");
    expect(persisted.jobs[0]).not.toHaveProperty("lastSessionId");
  });

  it("returns undefined when updating an unknown id", async () => {
    const { store } = await makeStore();
    expect(await store.update("nope", { enabled: false })).toBeUndefined();
  });

  it("deletes jobs and returns false for unknown ids", async () => {
    const { store } = await makeStore();
    const created = await store.create({ name: "A", schedule: "* * * * *", prompt: "", cwd: "/tmp" });
    expect(await store.delete(created.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(await store.delete(created.id)).toBe(false);
  });

  it("ignores malformed entries on load", async () => {
    const { file, store } = await makeStore();
    await fs.writeFile(file, JSON.stringify({ jobs: [{ name: "missing fields" }, { id: "x", name: "y", schedule: "* * * * *", prompt: "", cwd: "/tmp", enabled: true }] }));
    const jobs = await store.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe("x");
  });
});
