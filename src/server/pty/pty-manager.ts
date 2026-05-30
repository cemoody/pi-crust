/**
 * PtyManager — owns the lifecycle of pseudo-terminal (PTY) child processes for
 * the browser Terminal tab. Decoupled from the session registry: it only needs
 * a resolved `cwd` and emits ordered output chunks with a monotonic per-pty
 * `seq` so the realtime gateway can stream them exactly like session events.
 *
 * The actual child process is created through an injectable `PtySpawner` so the
 * unit suite can drive lifecycle logic with a fake child (no real shell), while
 * integration/e2e wire in `node-pty`.
 *
 * Spec: docs/terminal-wterm-tdd-plan.md (contract items 1–8).
 */

export interface PtyChild {
  /** Write bytes to the child's stdin. */
  write(data: string): void;
  /** Resize the underlying TTY. */
  resize(cols: number, rows: number): void;
  /** Subscribe to stdout/stderr chunks. Returns an unsubscribe. */
  onData(listener: (data: string) => void): () => void;
  /** Subscribe to process exit. Returns an unsubscribe. */
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void;
  /** Force-kill the child. Idempotent. */
  kill(signal?: string): void;
  /** Best-effort liveness check (used by tests to assert no orphans). */
  readonly pid: number;
}

export interface PtySpawnOptions {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly shell?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type PtySpawner = (options: PtySpawnOptions) => PtyChild;

export interface PtyDataEnvelope {
  readonly ptyId: string;
  readonly seq: number;
  readonly data: string;
}

export interface PtyExitEnvelope {
  readonly ptyId: string;
  readonly exitCode: number;
  readonly signal?: number;
}

export interface OpenPtyOptions {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyManagerOptions {
  readonly spawn: PtySpawner;
  /** Max buffered output bytes per pty before the manager emits a resync
   *  marker instead of growing unbounded. Defaults to 1 MiB. */
  readonly maxBufferedBytes?: number;
}

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024; // 1 MiB
const TRUNCATION_MARKER = "\r\n[pty: output truncated]\r\n";

interface PtyEntry {
  readonly child: PtyChild;
  seq: number;
  bufferedBytes: number;
  truncatedNotified: boolean;
  readonly unsubscribers: Array<() => void>;
}

function clampDimension(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored > 0 ? floored : null;
}

export class PtyManager {
  private readonly spawn: PtySpawner;
  private readonly maxBufferedBytes: number;
  private readonly ptys = new Map<string, PtyEntry>();
  private readonly dataListeners = new Set<(event: PtyDataEnvelope) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEnvelope) => void>();
  private nextId = 1;

  constructor(options: PtyManagerOptions) {
    this.spawn = options.spawn;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  open(options: OpenPtyOptions): string {
    const cols = clampDimension(options.cols) ?? 80;
    const rows = clampDimension(options.rows) ?? 24;
    const child = this.spawn({ cwd: options.cwd, cols, rows });
    const ptyId = `pty-${this.nextId++}`;
    const entry: PtyEntry = { child, seq: 0, bufferedBytes: 0, truncatedNotified: false, unsubscribers: [] };
    this.ptys.set(ptyId, entry);

    entry.unsubscribers.push(child.onData((data) => this.handleData(ptyId, entry, data)));
    entry.unsubscribers.push(child.onExit((event) => this.handleExit(ptyId, entry, event.exitCode, event.signal)));
    return ptyId;
  }

  input(ptyId: string, data: string): void {
    const entry = this.ptys.get(ptyId);
    if (!entry) return;
    entry.child.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(ptyId);
    if (!entry) return;
    const c = clampDimension(cols);
    const r = clampDimension(rows);
    if (c === null || r === null) return;
    entry.child.resize(c, r);
  }

  close(ptyId: string): void {
    const entry = this.ptys.get(ptyId);
    if (!entry) return;
    // kill() drives child.onExit, which routes through handleExit and cleans up
    // exactly once. If the child does not emit exit synchronously, fall back to
    // an explicit teardown so close() is always terminal + idempotent.
    entry.child.kill();
    if (this.ptys.has(ptyId)) this.handleExit(ptyId, entry, 137, 9);
  }

  onData(listener: (event: PtyDataEnvelope) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyExitEnvelope) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  has(ptyId: string): boolean {
    return this.ptys.has(ptyId);
  }

  disposeAll(): void {
    for (const ptyId of [...this.ptys.keys()]) this.close(ptyId);
  }

  private handleData(ptyId: string, entry: PtyEntry, data: string): void {
    entry.bufferedBytes += Buffer.byteLength(data, "utf8");
    if (entry.bufferedBytes > this.maxBufferedBytes && !entry.truncatedNotified) {
      entry.truncatedNotified = true;
      this.emitData(ptyId, entry, TRUNCATION_MARKER);
      return;
    }
    this.emitData(ptyId, entry, data);
  }

  private emitData(ptyId: string, entry: PtyEntry, data: string): void {
    entry.seq += 1;
    const envelope: PtyDataEnvelope = { ptyId, seq: entry.seq, data };
    for (const listener of [...this.dataListeners]) listener(envelope);
  }

  private handleExit(ptyId: string, entry: PtyEntry, exitCode: number, signal?: number): void {
    if (!this.ptys.has(ptyId)) return;
    this.ptys.delete(ptyId);
    for (const unsub of entry.unsubscribers) {
      try { unsub(); } catch { /* teardown must not throw */ }
    }
    const envelope: PtyExitEnvelope = signal === undefined ? { ptyId, exitCode } : { ptyId, exitCode, signal };
    for (const listener of [...this.exitListeners]) listener(envelope);
  }
}
