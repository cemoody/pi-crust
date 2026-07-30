import fsp from "node:fs/promises";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { readSessionMessagesTail, type TranscriptTailOptions } from "./transcript-tail-reader.js";
import type { SessionMessage } from "../pi/types.js";

/** Only large transcript tails pay worker startup overhead. */
export const TRANSCRIPT_TAIL_WORKER_MIN_BYTES = 512 * 1024;
/** Keep parsing from competing with the API process or spawning unbounded work. */
export const TRANSCRIPT_TAIL_WORKER_MAX = Math.max(1, Math.min(4, os.availableParallelism() - 1));

export interface TranscriptTailWorkerPoolOptions {
  readonly minBytes?: number;
  readonly maxWorkers?: number;
  /** Test instrumentation: called immediately before local CPU parsing starts. */
  readonly onMainThreadParseStart?: () => void;
  /** Test instrumentation: called once a worker has booted. */
  readonly onWorkerStarted?: () => void;
}

/**
 * A deliberately tiny, bounded worker pool for CPU-heavy JSONL normalization.
 * There is no queue: once saturated (or if worker creation fails), the proven
 * in-process reader remains the compatibility fallback rather than retaining
 * HTTP requests indefinitely.
 */
export class TranscriptTailWorkerPool {
  private readonly minBytes: number;
  private readonly maxWorkers: number;
  private readonly workers = new Set<Worker>();
  private readonly onMainThreadParseStart: (() => void) | undefined;
  private readonly onWorkerStarted: (() => void) | undefined;
  /**
   * Slots claimed before the asynchronous file-size check / worker bootstrap
   * completes. Counting only `workers` lets concurrent callers all observe an
   * empty pool, then each create a worker after their stat resolves.
   */
  private pendingWorkerSlots = 0;
  private closed = false;

  constructor(options: TranscriptTailWorkerPoolOptions = {}) {
    this.minBytes = options.minBytes ?? TRANSCRIPT_TAIL_WORKER_MIN_BYTES;
    this.maxWorkers = options.maxWorkers ?? TRANSCRIPT_TAIL_WORKER_MAX;
    this.onMainThreadParseStart = options.onMainThreadParseStart;
    this.onWorkerStarted = options.onWorkerStarted;
  }

  get activeWorkers(): number { return this.workers.size; }

  async read(sessionFile: string, options: TranscriptTailOptions): Promise<readonly SessionMessage[] | undefined> {
    if (!this.closed && this.reserveWorkerSlot()) {
      const shouldUseWorker = await this.isLargeTranscript(sessionFile);
      if (shouldUseWorker) {
        const result = await this.readInWorker(sessionFile, options).catch(() => undefined);
        // A worker failure must never change route semantics. Re-read locally;
        // undefined remains the caller's signal to use the adapter fallback.
        if (result !== undefined) return result;
      } else {
        this.releaseWorkerSlot();
      }
    }
    return readSessionMessagesTail(sessionFile, options, this.onMainThreadParseStart);
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = [...this.workers];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
  }

  private reserveWorkerSlot(): boolean {
    if (this.workers.size + this.pendingWorkerSlots >= this.maxWorkers) return false;
    this.pendingWorkerSlots++;
    return true;
  }

  private releaseWorkerSlot(): void {
    this.pendingWorkerSlots--;
  }

  private async isLargeTranscript(sessionFile: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(sessionFile);
      return stat.isFile() && stat.size >= this.minBytes;
    } catch {
      return false;
    }
  }

  private readInWorker(sessionFile: string, options: TranscriptTailOptions): Promise<readonly SessionMessage[] | undefined> {
    let worker: Worker;
    try {
      // Workers don't inherit tsx's TypeScript resolver. Register it inside
      // an ESM eval worker so `.js` specifiers in source map to `.ts` exactly
      // as they do in the API process; compiled distributions keep `.js`.
      const entry = new URL("./transcript-tail-worker.ts", import.meta.url).href;
      worker = new Worker(
        `import("tsx/esm/api").then(({ register }) => { register(); return import(${JSON.stringify(entry)}); })`,
        { eval: true, workerData: { sessionFile, options } },
      );
    } catch (error) {
      this.releaseWorkerSlot();
      return Promise.reject(error);
    }
    this.releaseWorkerSlot();
    this.workers.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.workers.delete(worker);
        fn();
      };
      worker.on("message", (message: unknown) => {
        if (!message || typeof message !== "object" || !('type' in message)) return;
        const result = message as { type: string; messages?: readonly SessionMessage[]; error?: string };
        if (result.type === "started") this.onWorkerStarted?.();
        if (result.type === "result") finish(() => resolve(result.messages));
        if (result.type === "error") finish(() => reject(new Error(result.error ?? "Transcript tail worker failed")));
      });
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => {
        if (code !== 0) finish(() => reject(new Error(`Transcript tail worker exited with code ${code}`)));
        else finish(() => reject(new Error("Transcript tail worker exited without a result")));
      });
    });
  }
}
