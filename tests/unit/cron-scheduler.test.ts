import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { CronStore } from "../../src/server/cron/cron-store.js";
import { CronScheduler } from "../../src/server/cron/cron-scheduler.js";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cron-sched-"));
  const projectRoot = path.join(root, "projects");
  const projectA = path.join(projectRoot, "a");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({
      allowedProjectRoots: [projectRoot],
      allowedSessionRoots: [sessionRoot],
    }),
  });
  const cronFile = path.join(root, "cron-jobs.json");
  const store = new CronStore(cronFile);
  const scheduler = new CronScheduler({ store, registry, logger: () => undefined });
  return { root, projectA, registry, store, scheduler };
}

describe("CronScheduler.runJobNow", () => {
  it("spawns a session and records lastRun + lastSessionId", async () => {
    const { projectA, store, scheduler, registry } = await setup();
    const before = (await registry.listSessions()).length;
    const job = await store.create({ name: "now", schedule: "0 0 * * *", prompt: "hi", cwd: projectA });
    const t0 = Date.now();
    const result = await scheduler.runJobNow(job.id);
    expect(result.sessionId).toBeTruthy();

    const after = (await registry.listSessions()).length;
    expect(after).toBe(before + 1);

    const fresh = await store.get(job.id);
    expect(fresh?.lastSessionId).toBe(result.sessionId);
    expect(fresh?.lastRun).toBeGreaterThanOrEqual(t0);
    expect(fresh?.nextRun).toBeGreaterThan(t0);
  });

  it("throws for unknown jobs", async () => {
    const { scheduler } = await setup();
    await expect(scheduler.runJobNow("missing")).rejects.toThrow(/not found/);
  });

  it("uses the job's cwd when creating the session", async () => {
    const { projectA, store, scheduler, registry } = await setup();
    const job = await store.create({ name: "n", schedule: "0 0 * * *", prompt: "x", cwd: projectA });
    const result = await scheduler.runJobNow(job.id);
    const sessions = await registry.listSessions();
    const created = sessions.find((s) => s.id === result.sessionId);
    expect(created?.cwd).toBe(projectA);
  });

  it("uses the job name as the session name with a 'cron:' prefix", async () => {
    const { projectA, store, scheduler, registry } = await setup();
    const job = await store.create({ name: "Nightly summary", schedule: "0 0 * * *", prompt: "", cwd: projectA });
    const result = await scheduler.runJobNow(job.id);
    const sessions = await registry.listSessions();
    const created = sessions.find((s) => s.id === result.sessionId);
    expect(created?.sessionName).toBe("cron: Nightly summary");
  });

  // Production repro: PiRpcSessionHandle.prompt() awaits the agent_end event
  // and therefore doesn't resolve until the LLM finishes the entire turn
  // (often many minutes). The previous CronScheduler.runJob awaited that
  // prompt promise, so the HTTP request from the pi-crust's "Run now" button
  // hung for the duration of the agent run, and cron-jobs.json wasn't
  // updated with lastRun/lastSessionId until the very end. From the user's
  // perspective the click did nothing.
  it("is fire-and-forget: returns and persists lastRun before the prompt resolves", async () => {
    const { projectA, store, scheduler, registry } = await setup();
    const job = await store.create({ name: "slow", schedule: "0 0 * * *", prompt: "do stuff", cwd: projectA });

    // Make the adapter's prompt block until we explicitly release it.
    let releasePrompt: (() => void) | null = null;
    const promptStarted: Promise<void> = new Promise((resolve) => {
      const original = registry.prompt.bind(registry);
      (registry as unknown as { prompt: typeof registry.prompt }).prompt = async (sessionId: string, message: string) => {
        // Kick off the real prompt without awaiting it.
        const slow = new Promise<void>((release) => { releasePrompt = release; }).then(() => original(sessionId, message));
        resolve();
        await slow;
      };
    });

    const t0 = Date.now();
    const runPromise = scheduler.runJobNow(job.id);
    // Race: if scheduler awaits the prompt, this will time out instead of resolving.
    const result = await Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("runJobNow blocked on prompt")), 1000)),
    ]) as Awaited<typeof runPromise>;

    expect(result.sessionId).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(1000);

    // lastRun + lastSessionId must be persisted before the prompt completes.
    await promptStarted;
    const fresh = await store.get(job.id);
    expect(fresh?.lastSessionId).toBe(result.sessionId);
    expect(fresh?.lastRun).toBeGreaterThanOrEqual(t0);

    // Finally, release the prompt so the worker can finish (cleanup).
    releasePrompt!();
  });
});

describe("CronScheduler.refreshNextRuns", () => {
  it("computes a nextRun for enabled jobs and clears it for disabled jobs", async () => {
    const { projectA, store, scheduler } = await setup();
    const enabled = await store.create({ name: "e", schedule: "*/5 * * * *", prompt: "", cwd: projectA });
    const disabled = await store.create({ name: "d", schedule: "*/5 * * * *", prompt: "", cwd: projectA, enabled: false });

    await scheduler.refreshNextRuns();

    const e = await store.get(enabled.id);
    const d = await store.get(disabled.id);
    expect(e?.nextRun).toBeGreaterThan(Date.now());
    expect(d?.nextRun).toBeUndefined();
  });

  it("leaves nextRun alone when the schedule is invalid", async () => {
    const { projectA, store, scheduler } = await setup();
    const bad = await store.create({ name: "bad", schedule: "not a cron", prompt: "", cwd: projectA });
    await scheduler.refreshNextRuns();
    const fresh = await store.get(bad.id);
    expect(fresh?.nextRun).toBeUndefined();
  });
});
