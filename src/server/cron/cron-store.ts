import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly enabled: boolean;
  readonly lastRun?: number;
  readonly nextRun?: number;
  readonly lastSessionId?: string;
}

export interface CronJobInput {
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly enabled?: boolean;
}

export interface CronJobPatch {
  readonly name?: string;
  readonly schedule?: string;
  readonly prompt?: string;
  readonly cwd?: string;
  readonly enabled?: boolean;
  readonly lastRun?: number;
  readonly nextRun?: number;
  readonly lastSessionId?: string;
}

export class CronStore {
  private readonly file: string;
  private jobs: CronJob[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  get filePath(): string {
    return this.file;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.jobs)) {
        this.jobs = parsed.jobs.filter(isCronJob);
      }
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw error;
      this.jobs = [];
    }
    this.loaded = true;
  }

  async list(): Promise<readonly CronJob[]> {
    await this.load();
    return this.jobs.slice();
  }

  async get(id: string): Promise<CronJob | undefined> {
    await this.load();
    return this.jobs.find((job) => job.id === id);
  }

  async create(input: CronJobInput): Promise<CronJob> {
    await this.load();
    const job: CronJob = {
      id: crypto.randomUUID(),
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      cwd: input.cwd,
      enabled: input.enabled ?? true,
    };
    this.jobs.push(job);
    await this.persist();
    return job;
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob | undefined> {
    await this.load();
    const idx = this.jobs.findIndex((job) => job.id === id);
    if (idx < 0) return undefined;
    const existing = this.jobs[idx]!;
    const next: CronJob = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.lastRun !== undefined ? { lastRun: patch.lastRun } : {}),
      ...(patch.nextRun !== undefined ? { nextRun: patch.nextRun } : {}),
      ...(patch.lastSessionId !== undefined ? { lastSessionId: patch.lastSessionId } : {}),
    };
    this.jobs[idx] = next;
    await this.persist();
    return next;
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    if (this.jobs.length === before) return false;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    const snapshot = { jobs: this.jobs };
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      await fs.rename(tmp, this.file);
    });
    await this.writeQueue;
  }
}

function isCronJob(value: unknown): value is CronJob {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string"
    && typeof v.name === "string"
    && typeof v.schedule === "string"
    && typeof v.prompt === "string"
    && typeof v.cwd === "string"
    && typeof v.enabled === "boolean";
}
