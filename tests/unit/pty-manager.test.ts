/**
 * TDD: PtyManager lifecycle logic (headless, fake child).
 * Spec: docs/terminal-wterm-tdd-plan.md contract items 1–8.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  PtyManager,
  type PtyChild,
  type PtyDataEnvelope,
  type PtyExitEnvelope,
  type PtySpawnOptions,
} from "../../src/server/pty/pty-manager.js";

// ---- Fake child harness ---------------------------------------------------

class FakeChild implements PtyChild {
  readonly pid: number;
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = 0;
  readonly spawnOptions: PtySpawnOptions;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();

  constructor(pid: number, options: PtySpawnOptions) {
    this.pid = pid;
    this.spawnOptions = options;
  }

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  kill(): void { this.killed += 1; this.emitExit(137, 9); }

  // Test triggers:
  emitData(data: string): void { for (const l of [...this.dataListeners]) l(data); }
  emitExit(exitCode: number, signal?: number): void {
    const event = signal === undefined ? { exitCode } : { exitCode, signal };
    for (const l of [...this.exitListeners]) l(event);
  }
}

const children: FakeChild[] = [];
let nextPid = 1000;

function makeManager(maxBufferedBytes?: number) {
  const spawn = (options: PtySpawnOptions): PtyChild => {
    const child = new FakeChild(nextPid++, options);
    children.push(child);
    return child;
  };
  return new PtyManager(maxBufferedBytes === undefined ? { spawn } : { spawn, maxBufferedBytes });
}

afterEach(() => { children.length = 0; nextPid = 1000; });

const CWD = "/tmp/project";

describe("PtyManager", () => {
  it("1. open() returns a unique live ptyId per spawn", () => {
    const m = makeManager();
    const a = m.open({ cwd: CWD, cols: 80, rows: 24 });
    const b = m.open({ cwd: CWD, cols: 80, rows: 24 });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(m.has(a)).toBe(true);
    expect(m.has(b)).toBe(true);
    expect(children).toHaveLength(2);
    expect(children[0]!.spawnOptions).toMatchObject({ cwd: CWD, cols: 80, rows: 24 });
  });

  it("2. forwards input bytes verbatim, including control chars", () => {
    const m = makeManager();
    const id = m.open({ cwd: CWD, cols: 80, rows: 24 });
    m.input(id, "ls -la\r");
    m.input(id, "\u0003"); // Ctrl-C
    expect(children[0]!.writes).toEqual(["ls -la\r", "\u0003"]);
  });

  it("3. streams output with a monotonic per-pty seq, in order", () => {
    const m = makeManager();
    const events: PtyDataEnvelope[] = [];
    m.onData((e) => events.push(e));
    const id = m.open({ cwd: CWD, cols: 80, rows: 24 });
    children[0]!.emitData("one");
    children[0]!.emitData("two");
    children[0]!.emitData("three");
    expect(events).toEqual([
      { ptyId: id, seq: 1, data: "one" },
      { ptyId: id, seq: 2, data: "two" },
      { ptyId: id, seq: 3, data: "three" },
    ]);
  });

  it("4. resize clamps to positive integers and rejects bad values", () => {
    const m = makeManager();
    const id = m.open({ cwd: CWD, cols: 80, rows: 24 });
    m.resize(id, 120, 40);
    expect(children[0]!.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });

    // Bad values are ignored (no resize forwarded), not crashed.
    m.resize(id, 0, 40);
    m.resize(id, -5, 40);
    m.resize(id, Number.NaN, 40);
    m.resize(id, 80.7, 24.2); // floored to ints
    expect(children[0]!.resizes).toEqual([{ cols: 120, rows: 40 }, { cols: 80, rows: 24 }]);
  });

  it("5. close() is idempotent — kills once, emits one exit", () => {
    const m = makeManager();
    const exits: PtyExitEnvelope[] = [];
    m.onExit((e) => exits.push(e));
    const id = m.open({ cwd: CWD, cols: 80, rows: 24 });
    m.close(id);
    m.close(id);
    expect(children[0]!.killed).toBe(1);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.ptyId).toBe(id);
    expect(m.has(id)).toBe(false);
  });

  it("6. propagates real exit code/signal then forgets the pty", () => {
    const m = makeManager();
    const exits: PtyExitEnvelope[] = [];
    m.onExit((e) => exits.push(e));
    const id = m.open({ cwd: CWD, cols: 80, rows: 24 });
    children[0]!.emitExit(7, 0);
    expect(exits).toEqual([{ ptyId: id, exitCode: 7, signal: 0 }]);
    expect(m.has(id)).toBe(false);
    // Operations on a dead/unknown pty are no-ops, not throws.
    expect(() => m.input(id, "x")).not.toThrow();
    expect(() => m.resize(id, 80, 24)).not.toThrow();
  });

  it("7. isolates two ptys — independent seq counters and input routing", () => {
    const m = makeManager();
    const events: PtyDataEnvelope[] = [];
    m.onData((e) => events.push(e));
    const a = m.open({ cwd: CWD, cols: 80, rows: 24 });
    const b = m.open({ cwd: CWD, cols: 80, rows: 24 });

    m.input(a, "to-a");
    m.input(b, "to-b");
    expect(children[0]!.writes).toEqual(["to-a"]);
    expect(children[1]!.writes).toEqual(["to-b"]);

    children[0]!.emitData("a1");
    children[1]!.emitData("b1");
    children[0]!.emitData("a2");
    expect(events).toEqual([
      { ptyId: a, seq: 1, data: "a1" },
      { ptyId: b, seq: 1, data: "b1" },
      { ptyId: a, seq: 2, data: "a2" },
    ]);
  });

  it("8. caps buffered output and emits a resync marker instead of growing unbounded", () => {
    const m = makeManager(8); // 8-byte cap
    const events: PtyDataEnvelope[] = [];
    m.onData((e) => events.push(e));
    const id = m.open({ cwd: CWD, cols: 80, rows: 24 });
    children[0]!.emitData("12345"); // 5 bytes
    children[0]!.emitData("67890"); // pushes past the cap
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // still monotonic
    // A resync sentinel is delivered (data is the marker, not silent loss).
    expect(events.some((e) => e.data.includes("[pty: output truncated]"))).toBe(true);
  });

  it("disposeAll() kills every live pty", () => {
    const m = makeManager();
    m.open({ cwd: CWD, cols: 80, rows: 24 });
    m.open({ cwd: CWD, cols: 80, rows: 24 });
    m.disposeAll();
    expect(children.every((c) => c.killed >= 1)).toBe(true);
  });
});
