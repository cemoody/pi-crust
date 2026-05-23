import type { SessionRegistry } from "../session/session-registry.js";
import type { CronJob, CronStore } from "./cron-store.js";
import { parseCron, nextRun, CronParseError } from "./cron-expression.js";

export interface CronSchedulerOptions {
  readonly store: CronStore;
  readonly registry: SessionRegistry;
  readonly intervalMs?: number;
  readonly logger?: (message: string, error?: unknown) => void;
}

export interface CronRunResult {
  readonly job: CronJob;
  readonly sessionId: string;
  readonly sessionFile: string;
}

export class CronScheduler {
  private readonly store: CronStore;
  private readonly registry: SessionRegistry;
  private readonly intervalMs: number;
  private readonly logger: (message: string, error?: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private lastTickMinute = -1;
  private firingPromises = new Map<string, Promise<void>>();

  constructor(options: CronSchedulerOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.intervalMs = options.intervalMs ?? 20_000;
    this.logger = options.logger ?? ((msg, err) => err ? console.error(`[cron] ${msg}`, err) : console.log(`[cron] ${msg}`));
  }

  async start(): Promise<void> {
    await this.refreshNextRuns();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    // Run a tick immediately to update nextRun fields after restart.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshNextRuns(): Promise<void> {
    const jobs = await this.store.list();
    const now = new Date();
    for (const job of jobs) {
      if (!job.enabled) {
        if (job.nextRun !== undefined) await this.store.update(job.id, { nextRun: undefined as unknown as number });
        continue;
      }
      try {
        const parsed = parseCron(job.schedule);
        const n = nextRun(parsed, now);
        if (n) await this.store.update(job.id, { nextRun: n.getTime() });
      } catch {
        // Leave nextRun alone; invalid schedules will be surfaced in UI.
      }
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    // Round down to the minute boundary; only evaluate once per minute.
    const minuteKey = Math.floor(now.getTime() / 60_000);
    if (minuteKey === this.lastTickMinute) return;
    this.lastTickMinute = minuteKey;
    const tickDate = new Date(minuteKey * 60_000);

    let jobs: readonly CronJob[];
    try {
      jobs = await this.store.list();
    } catch (error) {
      this.logger("Failed to read cron jobs", error);
      return;
    }

    for (const job of jobs) {
      if (!job.enabled) continue;
      let parsed;
      try {
        parsed = parseCron(job.schedule);
      } catch (error) {
        if (error instanceof CronParseError) {
          this.logger(`Skipping job ${job.id} ("${job.name}"): ${error.message}`);
        }
        continue;
      }
      // Match against current minute.
      if (!matchesMinute(parsed, tickDate)) continue;
      // De-dupe in case of overlapping ticks.
      if (job.lastRun && Math.floor(job.lastRun / 60_000) === minuteKey) continue;
      this.fireJob(job).catch((error) => this.logger(`Job "${job.name}" failed`, error));
    }
  }

  private fireJob(job: CronJob): Promise<void> {
    if (this.firingPromises.has(job.id)) return this.firingPromises.get(job.id)!;
    const promise = (async () => {
      try {
        await this.runJob(job);
      } finally {
        this.firingPromises.delete(job.id);
      }
    })();
    this.firingPromises.set(job.id, promise);
    return promise;
  }

  // Public entrypoint for "Run now" button.
  async runJobNow(jobId: string): Promise<CronRunResult> {
    const job = await this.store.get(jobId);
    if (!job) throw new Error(`Cron job not found: ${jobId}`);
    return this.runJob(job);
  }

  private async runJob(job: CronJob): Promise<CronRunResult> {
    const sessionName = `cron: ${job.name}`;
    const created = await this.registry.createSession({ cwd: job.cwd, sessionName });

    // Fire-and-forget: kick off the prompt, but do NOT await it. The pi RPC
    // adapter's prompt() blocks until the agent_end event fires, which for
    // a cron job (e.g. dependabot sweep) can be many minutes. If we awaited
    // it here the pi-crust's POST /api/cron/<id>/run would hang for the entire
    // agent run, never updating lastRun/lastSessionId and never returning
    // a sessionId to the user — from their POV the "Run now" click did
    // nothing.
    void this.registry.prompt(created.id, job.prompt)
      .catch((error) => this.logger(`Job "${job.name}" prompt failed`, error));

    const now = Date.now();
    let nextRunTs: number | undefined;
    try {
      const parsed = parseCron(job.schedule);
      const n = nextRun(parsed, new Date(now));
      nextRunTs = n?.getTime();
    } catch {
      nextRunTs = undefined;
    }
    await this.store.update(job.id, {
      lastRun: now,
      lastSessionId: created.id,
      ...(nextRunTs !== undefined ? { nextRun: nextRunTs } : {}),
    });
    this.logger(`Fired job "${job.name}" → session ${created.id}`);
    return { job, sessionId: created.id, sessionFile: created.sessionFile };
  }
}

function matchesMinute(parsed: ReturnType<typeof parseCron>, date: Date): boolean {
  const d = new Date(date.getTime());
  d.setSeconds(0, 0);
  // Reuse the matcher from cron-expression by importing it lazily would be cleaner,
  // but inlining keeps coupling tight.
  return parsed.minute.has(d.getMinutes())
    && parsed.hour.has(d.getHours())
    && parsed.month.has(d.getMonth() + 1)
    && ((parsed.domStar || parsed.dowStar)
      ? (parsed.dom.has(d.getDate()) && parsed.dow.has(d.getDay()))
      : (parsed.dom.has(d.getDate()) || parsed.dow.has(d.getDay())));
}
