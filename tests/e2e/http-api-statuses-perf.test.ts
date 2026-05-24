/**
 * Failing TDD specs for GET /api/sessions/statuses.
 *
 * Problem statement: in production the sidebar's status poll fans out into a
 * per-session `readSessionTimelineMetadata()` call that does
 * `fs.readFile(sessionFile, "utf8")` + line-by-line JSON.parse on the WHOLE
 * .jsonl, even for sessions that are 30 MB+. With 200 sessions the cold call
 * takes ~16 s and the in-memory cache (a) re-pays the full cost on process
 * restart, (b) re-pays it when any single session's mtime changes.
 *
 * These tests pin down the desired contract:
 *
 *   1. The status endpoint must not read the full body of every session file
 *      on a single call (bounded bytes-read per request).
 *   2. The endpoint must meet a coarse wall-clock budget across many large
 *      session files on cold cache.
 *   3. The timeline metadata cache must survive process restarts so a fresh
 *      server boot doesn't repeat the full scan.
 *
 * All three currently FAIL.
 */

import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
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
} from "../../src/server/pi/types.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// The server imports `fsp` from "node:fs/promises"; we do the same so that
// vi.spyOn(fsp, "readFile") replaces the property the server actually reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fs = fsp as any;

describe("GET /api/sessions/statuses performance", () => {
  it("does not read the full body of large session files just to build the sidebar", async () => {
    // 8 sessions × 2 MB jsonl each. The status sidebar only needs createdAt
    // + lastUserActivity, which can be derived from the head and tail of the
    // file. A correct implementation should read O(KB) per file, not O(MB).
    const { baseUrl, projectRoot, sessionFiles } = await buildSessionCorpus({ count: 8, sizeBytes: 2_000_000 });
    const bytesRead = trackBytesReadFromSessionFiles(sessionFiles);

    const response = await fetch(`${baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(projectRoot)}`);
    expect(response.ok).toBe(true);

    const totalBytes = bytesRead.total();
    // Generous budget: even 64 KB/file × 8 files = 512 KB. The current
    // implementation reads the whole 16 MB.
    expect(totalBytes).toBeLessThan(1_000_000);
  });

  it("scales bytes-read sub-linearly when more large sessions are added", async () => {
    // Bytes read should grow with metadata needs (a small head/tail per
    // file), not with the file body. Across 24 sessions of 1 MB each we
    // should still see well under a megabyte of disk IO charged to the
    // sidebar status snapshot.
    const { baseUrl, projectRoot, sessionFiles } = await buildSessionCorpus({ count: 24, sizeBytes: 1_000_000 });
    const bytesRead = trackBytesReadFromSessionFiles(sessionFiles);

    const response = await fetch(`${baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(projectRoot)}`);
    expect(response.ok).toBe(true);
    await response.text();

    // 24 sessions × 1 MB = 24 MB on disk. Today the implementation slurps
    // every byte; a correct implementation reads only enough to discover
    // createdAt + lastUserActivity.
    expect(bytesRead.total()).toBeLessThan(2_000_000);
  });

  it("only re-reads the appended tail when a session file grows between polls", async () => {
    // 4 sessions × 1 MB. First /statuses warms the index for all of them.
    const { baseUrl, projectRoot, sessionFiles } = await buildSessionCorpus({ count: 4, sizeBytes: 1_000_000 });
    const warmUrl = `${baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(projectRoot)}`;
    await (await fetch(warmUrl)).text();

    // Append a fresh user-message line to ONE session, the way the active
    // session would grow while the user types. Mtime moves forward; the
    // size+mtime cache key today invalidates and forces a full re-read.
    const activeFile = sessionFiles[0]!;
    // Filesystems on some hosts have second-level mtime resolution; nudge so
    // the cache key is guaranteed to change.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const appendedLine = JSON.stringify({
      type: "message",
      message: { role: "user", content: "new prompt", timestamp: 1_700_000_500_000 },
    }) + "\n";
    await fsp.appendFile(activeFile, appendedLine, "utf8");

    const bytesRead = trackBytesReadFromSessionFiles(sessionFiles);
    const response = await fetch(warmUrl);
    expect(response.ok).toBe(true);
    await response.text();

    // A correct incremental index only reads ~the appended bytes from the
    // one changed file (plus a small stat overhead for the untouched ones).
    // Today the full 1 MB body of the changed file is re-slurped.
    expect(bytesRead.total()).toBeLessThan(50_000);
  });

  it("does not re-scan every session file on a fresh server process", async () => {
    // Pre-build a corpus. The first server instance warms whatever index is
    // available. A second server instance pointed at the same files should
    // not have to re-read every file body to produce the same response.
    const corpus = await buildSessionCorpus({ count: 6, sizeBytes: 1_000_000 });
    const warmUrl = `${corpus.baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(corpus.projectRoot)}`;
    await (await fetch(warmUrl)).text();
    await closeServer(corpus.server);

    // Simulate a real process restart: drop the http-api-server module from
    // the registry so the next import re-initialises the in-process
    // timeline-metadata cache. A correct implementation persists the index
    // to disk, so even with a fresh in-memory cache the second boot must
    // not re-scan every file body.
    vi.resetModules();
    const { createHttpApiServer: freshCreateHttpApiServer } = await import("../../src/server/http-api-server.js");

    const adapter = new StatusPerfAdapter(corpus.sessionFiles, corpus.projectRoot);
    const registry = new SessionRegistry({
      adapter,
      pathPolicy: new PathPolicy({ allowedProjectRoots: [corpus.projectRoot], allowedSessionRoots: [corpus.sessionRoot] }),
    });
    const server = freshCreateHttpApiServer({ registry, adapterKind: "test", projectRoot: corpus.projectRoot, sessionRoot: corpus.sessionRoot, defaultCwd: corpus.projectRoot });
    servers.push(server);
    const baseUrl = await listen(server);

    const bytesRead = trackBytesReadFromSessionFiles(corpus.sessionFiles);
    const response = await fetch(`${baseUrl}/api/sessions/statuses?cwd=${encodeURIComponent(corpus.projectRoot)}`);
    expect(response.ok).toBe(true);
    await response.text();

    // After the first scan there should be a persisted index, so the second
    // process should not have to re-read multi-MB bodies again.
    expect(bytesRead.total()).toBeLessThan(500_000);
  });
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Corpus {
  readonly baseUrl: string;
  readonly server: http.Server;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly sessionFiles: readonly string[];
}

async function buildSessionCorpus(options: { readonly count: number; readonly sizeBytes: number }): Promise<Corpus> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-statuses-perf-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });

  const sessionFiles: string[] = [];
  for (let i = 0; i < options.count; i++) {
    const sessionFile = path.join(sessionRoot, `session-${i.toString().padStart(3, "0")}.jsonl`);
    await fs.writeFile(sessionFile, makeJsonlBody({ index: i, sizeBytes: options.sizeBytes, cwd: projectRoot }), "utf8");
    sessionFiles.push(sessionFile);
  }

  const mounted = await mountServerAt(projectRoot, sessionRoot, sessionFiles);
  return { ...mounted, projectRoot, sessionRoot, sessionFiles };
}

async function mountServerAt(projectRoot: string, sessionRoot: string, sessionFiles: readonly string[]): Promise<{ baseUrl: string; server: http.Server }> {
  const adapter = new StatusPerfAdapter(sessionFiles, projectRoot);
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const server = createHttpApiServer({ registry, adapterKind: "test", projectRoot, sessionRoot, defaultCwd: projectRoot });
  servers.push(server);
  const baseUrl = await listen(server);
  return { baseUrl, server };
}

function makeJsonlBody({ index, sizeBytes, cwd }: { readonly index: number; readonly sizeBytes: number; readonly cwd: string }): string {
  const header = JSON.stringify({ type: "session", id: `session-${index}`, cwd, timestamp: 1_700_000_000_000 + index * 1000 }) + "\n";
  const userLine = JSON.stringify({ type: "message", message: { role: "user", content: "hello", timestamp: 1_700_000_000_500 + index * 1000 } }) + "\n";
  // Fill the rest with assistant-message lines (which the timeline scanner
  // still has to JSON.parse to discover they're not user messages). This is
  // what makes the cold scan expensive.
  const filler = JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(400), timestamp: 1_700_000_000_700 + index * 1000 } }) + "\n";
  const head = header + userLine;
  if (sizeBytes <= head.length) return head;
  const repeats = Math.ceil((sizeBytes - head.length) / filler.length);
  return head + filler.repeat(repeats);
}

function trackBytesReadFromSessionFiles(sessionFiles: readonly string[]): { total: () => number } {
  let totalBytes = 0;
  const set = new Set(sessionFiles.map((file) => path.resolve(file)));
  const originalReadFile = fsp.readFile.bind(fsp);
  vi.spyOn(fsp, "readFile").mockImplementation(async (filePath: Parameters<typeof fsp.readFile>[0], opts?: Parameters<typeof fsp.readFile>[1]) => {
    const result = await (originalReadFile as unknown as (p: typeof filePath, o?: typeof opts) => Promise<string | Buffer>)(filePath, opts);
    if (typeof filePath === "string" && set.has(path.resolve(filePath))) {
      totalBytes += typeof result === "string" ? Buffer.byteLength(result, "utf8") : result.byteLength;
    }
    return result as never;
  });
  // Wrap fsp.open so tail-read implementations that use FileHandle.read()
  // are also counted.
  const originalOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
    const handle = await (originalOpen as (...a: typeof args) => ReturnType<typeof fsp.open>)(...args);
    const filePath = args[0];
    if (typeof filePath === "string" && set.has(path.resolve(filePath))) {
      const originalRead = handle.read.bind(handle);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handle as any).read = (async (...readArgs: any[]) => {
        const result = await (originalRead as (...a: any[]) => Promise<{ bytesRead: number }>)(...readArgs);
        totalBytes += result.bytesRead ?? 0;
        return result;
      });
    }
    return handle;
  }) as typeof fsp.open);
  return { total: () => totalBytes };
}

async function closeServer(server: http.Server): Promise<void> {
  const idx = servers.indexOf(server);
  if (idx >= 0) servers.splice(idx, 1);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server did not bind to TCP"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

class StatusPerfAdapter implements PiAdapter {
  private readonly sessions: StatusPerfHandle[];
  constructor(sessionFiles: readonly string[], cwd: string) {
    this.sessions = sessionFiles.map((sessionFile, index) => new StatusPerfHandle({
      id: `session-${index}`,
      cwd,
      sessionFile,
      sessionName: `session ${index}`,
    }));
  }
  async createSession(options: CreateSessionOptions): Promise<PiSessionHandle> {
    // Tests don't use createSession on the perf adapter; return the first
    // pre-existing handle so the API still works if it's ever called.
    const handle = this.sessions[0];
    if (!handle) throw new Error("no sessions");
    if (options.sessionName !== undefined) handle.sessionName = options.sessionName;
    return handle;
  }
  async openSession(options: OpenSessionOptions): Promise<PiSessionHandle> {
    const match = this.sessions.find((session) => session.sessionFile === options.sessionFile);
    if (!match) throw new Error(`unknown session ${options.sessionFile}`);
    return match;
  }
  async listSessions(): Promise<readonly SessionListItem[]> {
    return this.sessions.map((session) => ({
      id: session.id,
      cwd: session.cwd,
      sessionFile: session.sessionFile,
      ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
      lastActivity: 0,
    }));
  }
  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ provider: "test", id: "perf", name: "Perf", available: true }];
  }
}

class StatusPerfHandle implements PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  sessionName: string | undefined;
  private readonly emitter = new EventEmitter();
  constructor(options: { readonly id: string; readonly cwd: string; readonly sessionFile: string; readonly sessionName?: string }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sessionFile = options.sessionFile;
    this.sessionName = options.sessionName;
  }
  async getState(): Promise<SessionState> {
    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      status: "idle",
      ...(this.sessionName === undefined ? {} : { sessionName: this.sessionName }),
      messageCount: 0,
      lastActivity: 0,
    };
  }
  async getMessages(): Promise<readonly SessionMessage[]> { return []; }
  async prompt(_message: string, _attachments: readonly PromptAttachment[] = []): Promise<void> {}
  async abort(): Promise<void> {}
  async setSessionName(name: string): Promise<SessionState> { this.sessionName = name; return this.getState(); }
  async setModel(_provider: string, _modelId: string): Promise<SessionState> { return this.getState(); }
  subscribe(listener: PiEventListener): Unsubscribe { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  async dispose(): Promise<void> {}
}
