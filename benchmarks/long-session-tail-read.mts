#!/usr/bin/env tsx
/**
 * Isolated long-session benchmark.
 *
 * This intentionally does NOT contact a running pi-crust instance. It creates
 * a temporary JSONL transcript, starts an in-process HTTP API on an ephemeral
 * loopback port, exercises only that server, and deletes everything on exit.
 *
 * The fixture contains large persisted artifact records positioned inside the
 * recent history window. This models a real session that accumulated large
 * artifacts or tool output, where a seemingly-small `GET /messages?limit=N`
 * request still has to cross and parse multi-megabyte JSONL records.
 *
 * Run:
 *   npm run bench:long-session
 *   PI_CRUST_BENCH_GIANT_RECORD_BYTES=1048576 npm run bench:long-session
 *   PI_CRUST_BENCH_MAX_P50_MS=250 npm run bench:long-session # optional gate
 */
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createHttpApiServer } from "../src/server/http-api-server.js";
import type {
  CreateSessionOptions,
  ModelInfo,
  OpenSessionOptions,
  PiAdapter,
  PiEventListener,
  PiSessionHandle,
  PromptAttachment,
  SessionListItem,
  SessionMessage,
  SessionState,
  Unsubscribe,
} from "../src/server/pi/types.js";
import { PathPolicy } from "../src/server/security/path-policy.js";
import { SessionRegistry } from "../src/server/session/session-registry.js";

const LIMIT = integerEnv("PI_CRUST_BENCH_LIMIT", 80);
const TURNS = integerEnv("PI_CRUST_BENCH_TURNS", 140);
const GIANT_RECORD_BYTES = integerEnv("PI_CRUST_BENCH_GIANT_RECORD_BYTES", 6 * 1024 * 1024);
const GIANT_RECORD_COUNT = integerEnv("PI_CRUST_BENCH_GIANT_RECORD_COUNT", 12);
const SAMPLES = integerEnv("PI_CRUST_BENCH_SAMPLES", 7);
const CONCURRENCY = integerEnv("PI_CRUST_BENCH_CONCURRENCY", 6);
const OUTPUT_PREVIEW_BYTES = 2_048;

interface DashboardMessage {
  readonly timestamp?: number;
}

interface SampleSummary {
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

interface BenchmarkResult {
  readonly fixture: {
    readonly fileBytes: number;
    readonly fileMiB: number;
    readonly turns: number;
    readonly giantRecordCount: number;
    readonly giantRecordMiB: number;
    readonly recentWindowLimit: number;
  };
  readonly response: {
    readonly messages: number;
    readonly bytes: number;
    readonly kib: number;
  };
  readonly isolatedServer: {
    readonly baseUrl: string;
    readonly note: string;
  };
  readonly singleRequestMs: SampleSummary;
  readonly concurrentTimelineReadsMs: SampleSummary;
  readonly healthMs: {
    readonly baseline: SampleSummary;
    readonly whileConcurrentReads: SampleSummary;
  };
}

async function main(): Promise<void> {
  const fixture = await createFixture();
  let server: http.Server | undefined;
  try {
    const adapter = new FixtureAdapter(fixture.sessionFile, fixture.projectRoot);
    const registry = new SessionRegistry({
      adapter,
      pathPolicy: new PathPolicy({
        allowedProjectRoots: [fixture.projectRoot],
        allowedSessionRoots: [fixture.sessionRoot],
      }),
    });
    await registry.createSession({ cwd: fixture.projectRoot, sessionName: "isolated long-session benchmark" });
    server = createHttpApiServer({
      registry,
      adapterKind: "isolated-benchmark",
      projectRoot: fixture.projectRoot,
      sessionRoot: fixture.sessionRoot,
      defaultCwd: fixture.projectRoot,
    });
    const baseUrl = await listen(server);
    const messagesUrl = `${baseUrl}/api/sessions/${adapter.handle.id}/messages?limit=${LIMIT}`;

    // Warm module loading / the route once; timing begins after this request.
    const warm = await timedFetch(messagesUrl);
    if (warm.messageCount !== LIMIT) {
      throw new Error(`Fixture invariant failed: expected ${LIMIT} messages, received ${warm.messageCount}`);
    }

    const single = await samples(SAMPLES, () => timedFetch(messagesUrl));
    const healthUrl = `${baseUrl}/api/health`;
    const healthBaseline = await samples(20, () => timedFetch(healthUrl));

    // Start costly tail reads, then probe a trivial API route. This reveals
    // whether synchronous parsing/buffer work starves unrelated requests.
    const concurrentReads = Array.from({ length: CONCURRENCY }, () => timedFetch(messagesUrl));
    await sleep(25);
    const healthDuring = await samples(30, () => timedFetch(healthUrl));
    const concurrent = await Promise.all(concurrentReads);
    const response = single[0]!;

    const result: BenchmarkResult = {
      fixture: {
        fileBytes: fixture.fileBytes,
        fileMiB: round(fixture.fileBytes / 1024 / 1024),
        turns: TURNS,
        giantRecordCount: GIANT_RECORD_COUNT,
        giantRecordMiB: round(GIANT_RECORD_BYTES / 1024 / 1024),
        recentWindowLimit: LIMIT,
      },
      response: {
        messages: response.messageCount,
        bytes: response.bytes,
        kib: round(response.bytes / 1024),
      },
      isolatedServer: {
        baseUrl,
        note: "Ephemeral in-process server only; no request was made to an existing pi-crust server.",
      },
      singleRequestMs: summarize(single.map((sample) => sample.ms)),
      concurrentTimelineReadsMs: summarize(concurrent.map((sample) => sample.ms)),
      healthMs: {
        baseline: summarize(healthBaseline.map((sample) => sample.ms)),
        whileConcurrentReads: summarize(healthDuring.map((sample) => sample.ms)),
      },
    };

    console.log(renderReport(result));
    const maxP50 = optionalPositiveNumberEnv("PI_CRUST_BENCH_MAX_P50_MS");
    if (maxP50 !== undefined && result.singleRequestMs.p50 > maxP50) {
      throw new Error(`Single-request p50 ${result.singleRequestMs.p50}ms exceeds PI_CRUST_BENCH_MAX_P50_MS=${maxP50}ms`);
    }
  } finally {
    if (server) await close(server);
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
}

async function createFixture(): Promise<{
  readonly root: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly sessionFile: string;
  readonly fileBytes: number;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-crust-long-session-bench-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  const sessionFile = path.join(sessionRoot, "giant-records.jsonl");
  await Promise.all([fsp.mkdir(projectRoot, { recursive: true }), fsp.mkdir(sessionRoot, { recursive: true })]);

  const giantPayload = "G".repeat(GIANT_RECORD_BYTES);
  const giantTurns = giantTurnIndexes(TURNS, GIANT_RECORD_COUNT);
  const lines: string[] = [];
  let timestamp = 1_710_000_000_000;
  lines.push(JSON.stringify({ type: "session", id: "isolated-long-session", cwd: projectRoot, timestamp: new Date(timestamp).toISOString() }));
  for (let turn = 0; turn < TURNS; turn++) {
    timestamp += 1_000;
    lines.push(JSON.stringify({
      type: "message",
      id: `u-${turn}`,
      timestamp: new Date(timestamp).toISOString(),
      message: { role: "user", content: [{ type: "text", text: turn === 0 ? "FIRST-MESSAGE-MARKER" : `prompt ${turn}` }] },
    }));
    const toolCallId = `tool-${turn}`;
    timestamp += 1_000;
    lines.push(JSON.stringify({
      type: "message",
      id: `a-${turn}`,
      timestamp: new Date(timestamp).toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `echo ${turn}` } }] },
    }));
    timestamp += 1;
    lines.push(JSON.stringify({
      type: "message",
      id: `r-${turn}`,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "toolResult",
        toolCallId,
        content: [{ type: "text", text: `result ${turn}` }],
      },
    }));
    if (giantTurns.has(turn)) {
      timestamp += 1;
      lines.push(JSON.stringify({
        // Artifact custom records mirror a common real-session shape: their
        // details are deliberately stripped for `/messages`, but the tail
        // reader must still locate the newline and JSON.parse all 6 MiB.
        type: "custom_message",
        id: `artifact-${turn}`,
        timestamp: new Date(timestamp).toISOString(),
        customType: "artifact",
        content: "large artifact placeholder",
        details: { artifactGroupId: `artifact-${turn}`, blob: `GIANT-RECORD-${turn}:${giantPayload}` },
      }));
    }
  }
  await fsp.writeFile(sessionFile, `${lines.join("\n")}\n`);
  const stat = await fsp.stat(sessionFile);
  return { root, projectRoot, sessionRoot, sessionFile, fileBytes: stat.size };
}

function giantTurnIndexes(turns: number, count: number): ReadonlySet<number> {
  // Put all giant records in the most recent history so a limit=80 request
  // cannot avoid them. Spread them across the final ~50 turns.
  const start = Math.max(0, turns - Math.max(50, count));
  const indexes = new Set<number>();
  for (let i = 0; i < count; i++) indexes.add(start + Math.floor(i * (turns - start - 1) / Math.max(1, count - 1)));
  return indexes;
}

async function timedFetch(url: string): Promise<{ readonly ms: number; readonly bytes: number; readonly messageCount: number }> {
  const start = performance.now();
  const response = await fetch(url);
  const body = await response.arrayBuffer();
  const ms = performance.now() - start;
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  let messageCount = 0;
  if (url.includes("/messages?")) {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as readonly DashboardMessage[];
    messageCount = parsed.length;
  }
  return { ms, bytes: body.byteLength, messageCount };
}

async function samples<T>(count: number, run: () => Promise<T>): Promise<T[]> {
  const result: T[] = [];
  for (let i = 0; i < count; i++) result.push(await run());
  return result;
}

function summarize(values: readonly number[]): SampleSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    min: round(percentile(0)),
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(percentile(1)),
    mean: round(values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)),
  };
}

function renderReport(result: BenchmarkResult): string {
  const line = (name: string, value: SampleSummary) => `| ${name} | ${value.min} | ${value.p50} | ${value.p95} | ${value.max} | ${value.mean} |`;
  return [
    "# Isolated long-session tail-read benchmark",
    "",
    `Fixture: **${result.fixture.fileMiB} MiB** JSONL · ${result.fixture.turns} turns · ${result.fixture.giantRecordCount} giant artifact records × ${result.fixture.giantRecordMiB} MiB · limit=${result.fixture.recentWindowLimit}`,
    `Response: ${result.response.messages} messages · ${result.response.kib} KiB after server-side output truncation`,
    result.isolatedServer.note,
    "",
    "| Request group | min ms | p50 ms | p95 ms | max ms | mean ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    line("Single timeline read", result.singleRequestMs),
    line(`Concurrent timeline read (n=${CONCURRENCY})`, result.concurrentTimelineReadsMs),
    line("Health baseline", result.healthMs.baseline),
    line("Health during concurrent reads", result.healthMs.whileConcurrentReads),
    "",
    "Interpretation: the health delta measures API event-loop interference while the transcript tail is scanned.",
  ].join("\n");
}

function integerEnv(name: string, fallback: number): number {
  const value = optionalPositiveNumberEnv(name);
  return value === undefined ? fallback : Math.floor(value);
}

function optionalPositiveNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number; got ${raw}`);
  return value;
}

function round(value: number): number { return Math.round(value * 10) / 10; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Expected TCP server address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

class FixtureAdapter implements PiAdapter {
  readonly handle: FixtureHandle;
  constructor(sessionFile: string, cwd: string) { this.handle = new FixtureHandle("isolated-long-session", cwd, sessionFile); }
  async createSession(_options: CreateSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async openSession(_options: OpenSessionOptions): Promise<PiSessionHandle> { return this.handle; }
  async listSessions(): Promise<readonly SessionListItem[]> {
    return [{ id: this.handle.id, cwd: this.handle.cwd, sessionFile: this.handle.sessionFile, lastActivity: 0 }];
  }
  async listModels(): Promise<readonly ModelInfo[]> { return [{ provider: "benchmark", id: "local", name: "Local", available: true }]; }
}

class FixtureHandle implements PiSessionHandle {
  sessionName: string | undefined;
  private readonly emitter = new EventEmitter();
  constructor(readonly id: string, readonly cwd: string, readonly sessionFile: string) {}
  async getState(): Promise<SessionState> { return { id: this.id, cwd: this.cwd, sessionFile: this.sessionFile, status: "idle", messageCount: 0, lastActivity: 0 }; }
  async getMessages(): Promise<readonly SessionMessage[]> { throw new Error("Benchmark must exercise the JSONL tail-read path, not adapter getMessages()."); }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
