import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require_ = createRequire(import.meta.url);
const scheduleExtDir = path.dirname(require_.resolve("@cemoody/pi-crust-ext-schedule/package.json"));
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapPrcExtensions } from "../../src/extensions/bootstrap.js";
import { writePrcSettings } from "../../src/extensions/packages.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("bundled core.schedule server extension", () => {
  it("does not register schedule routes when core.schedule is disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-schedule-disabled-"));
    roots.push(root);
    const configDir = path.join(root, "config");
    await writePrcSettings(configDir, { disabledExtensions: ["@cemoody/pi-crust-ext-schedule"] });

    const result = await bootstrapPrcExtensions({
      configDir,
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [scheduleExtDir],
    });

    expect(result.host.activity.list()).toEqual([]);
    expect(await result.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/cron"))).toBeUndefined();
  });

  it("registers /api/cron compatibility routes through the package extension host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-schedule-extension-"));
    roots.push(root);
    const prompts: Array<{ sessionId: string; prompt: string }> = [];
    const result = await bootstrapPrcExtensions({
      configDir: path.join(root, "config"),
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [scheduleExtDir],
      sessions: {
        create: async (input) => ({ id: "s1", sessionFile: "/sessions/s1.json", ...input }),
        prompt: async (sessionId, prompt) => { prompts.push({ sessionId, prompt }); },
      },
    });

    const created = await result.host.serverRoutes.dispatch(ReadableRequest.fromJson("POST", {
      name: "Nightly",
      schedule: "0 1 * * *",
      prompt: "summarize",
      cwd: root,
    }) as never, new URL("http://localhost/api/cron"));
    expect(created?.status).toBe(200);
    expect(created?.body).toMatchObject({ name: "Nightly", prompt: "summarize", cwd: root, enabled: true });

    const listed = await result.host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/cron"));
    expect(listed?.body).toMatchObject({ jobs: [expect.objectContaining({ name: "Nightly" })] });

    const jobId = (created?.body as { id: string }).id;
    const run = await result.host.serverRoutes.dispatch(ReadableRequest.empty("POST") as never, new URL(`http://localhost/api/cron/${jobId}/run`));
    expect(run?.body).toMatchObject({ sessionId: "s1", sessionFile: "/sessions/s1.json" });
    expect(prompts).toEqual([{ sessionId: "s1", prompt: "summarize" }]);
  });

  it("returns from run now before a long prompt completes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-schedule-run-now-"));
    roots.push(root);
    const result = await bootstrapPrcExtensions({
      configDir: path.join(root, "config"),
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [scheduleExtDir],
      sessions: {
        create: async (input) => ({ id: "slow-session", sessionFile: "/sessions/slow.json", ...input }),
        prompt: async () => new Promise<void>(() => undefined),
      },
    });

    const created = await result.host.serverRoutes.dispatch(ReadableRequest.fromJson("POST", {
      name: "Slow",
      schedule: "0 1 * * *",
      prompt: "take a while",
      cwd: root,
    }) as never, new URL("http://localhost/api/cron"));
    const jobId = (created?.body as { id: string }).id;

    const run = await Promise.race([
      result.host.serverRoutes.dispatch(ReadableRequest.empty("POST") as never, new URL(`http://localhost/api/cron/${jobId}/run`)),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 200)),
    ]);

    expect(run).not.toBe("timed out");
    expect(run).toMatchObject({ body: { sessionId: "slow-session", sessionFile: "/sessions/slow.json" } });
  });

  it("claims a due scheduled job only once across concurrent schedulers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-schedule-claim-"));
    roots.push(root);
    const { __test } = await import(pathToFileURL(path.join(scheduleExtDir, "server.mjs")).href) as {
      __test: {
        createStore(filePath: string): {
          filePath: string;
          create(job: Record<string, unknown>): Promise<Record<string, unknown>>;
          get(id: string): Promise<Record<string, unknown> | null>;
        };
        tick(store: unknown, prc: unknown, now?: number): Promise<void>;
      };
    };
    const file = path.join(root, "cron-jobs.json");
    const storeA = __test.createStore(file);
    const storeB = __test.createStore(file);
    const now = Date.UTC(2026, 0, 1, 13, 0, 0);
    await storeA.create({
      id: "job-1",
      name: "QXO",
      schedule: "* * * * *",
      prompt: "brief me",
      cwd: root,
      enabled: true,
      nextRun: now - 1,
      lastRun: null,
      lastSessionId: null,
    });
    const createdSessions: string[] = [];
    const prc = {
      sessions: {
        create: async () => {
          const id = `s${createdSessions.length + 1}`;
          createdSessions.push(id);
          return { id, sessionFile: `/sessions/${id}.json` };
        },
        prompt: async () => new Promise<void>(() => undefined),
      },
    };

    await Promise.all([__test.tick(storeA, prc, now), __test.tick(storeB, prc, now)]);

    expect(createdSessions).toEqual(["s1"]);
    await expect(storeA.get("job-1")).resolves.toMatchObject({ lastRun: now, lastSessionId: "s1" });
  });
});

class ReadableRequest {
  method: string;
  headers: Record<string, string> = {};

  private constructor(method: string, private readonly chunks: readonly Buffer[]) {
    this.method = method;
  }

  static fromJson(method: string, body: unknown): ReadableRequest {
    return new ReadableRequest(method, [Buffer.from(JSON.stringify(body))]);
  }

  static empty(method: string): ReadableRequest {
    return new ReadableRequest(method, []);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    yield* this.chunks;
  }
}
