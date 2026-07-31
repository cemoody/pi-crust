/**
 * Client-side supervision boundary for the detached Pi RPC worker protocol.
 *
 * `pirpc-pi-adapter` owns Pi-facing session semantics; this module owns the
 * transport lifecycle shared by spawned and reattached supervisors: detached
 * startup, hello/resume, request correlation, socket replacement, and the
 * operational events emitted when that transport closes or recovers.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import { isRecord } from "../../../shared/util.js";
import { WorkerRegistry } from "../../session/worker-registry.js";

export type Unsubscribe = () => void;

interface RpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command?: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

interface PendingRequest {
  readonly resolve: (value: RpcResponse) => void;
  readonly reject: (error: Error) => void;
}
export interface SupervisedSpawnOptions {
  readonly piCommand: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly supervisorScript: string;
  readonly workerRegistry: WorkerRegistry;
}

export interface SupervisedConnectOptions {
  readonly socketPath: string;
  readonly resumeFromSeq: number | null;
}

interface SupervisorHelloAck {
  readonly t: "hello";
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly lastSeq?: number;
  readonly ringLowSeq?: number | null;
}

/**
 * Client side of the supervisor wire protocol. Owns a single Unix-socket
 * connection at a time, but the supervisor process itself outlives any
 * particular adapter connection.
 */
export class SupervisedRpcProcess {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventEmitter = new EventEmitter();
  private socket: net.Socket;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private disposeRequested = false;
  private detached = false;
  private lastSeq = 0;

  // Reconnect state. socketPath is captured at construction so a transient
  // socket close (e.g. supervisor's currentClient eviction, kernel-side
  // half-close, etc.) can be transparently recovered by request() before it
  // gives up. reopening is a singleton promise to deduplicate concurrent
  // reopen attempts that hit at the same time.
  private socketPath: string | null = null;
  private reopening: Promise<boolean> | null = null;
  private reopenAttempts = 0;
  private static readonly RECONNECT_MAX_ATTEMPTS_PER_REQUEST = 1;

  // Observability: track close lifecycle + last request so the structured
  // unexpected-close log is actionable. See logUnexpectedClose() below.
  readonly openedAt: number = Date.now();
  closedAt: number | null = null;
  lastRequestType: string | null = null;
  // Populated by PiRpcSessionHandle.reattach()/spawn() before any request,
  // so the close-log can name the session that just broke.
  observabilityContext: {
    sessionId?: string;
    supervisorPid?: number;
    socketPath?: string;
  } = {};

  isClosed(): boolean {
    return this.closed;
  }

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.attachSocketHandlers();
  }

  static async spawnDetached(
    options: SupervisedSpawnOptions,
  ): Promise<SupervisedRpcProcess> {
    await options.workerRegistry.ensureDirs();
    const workerToken = crypto.randomUUID();
    const readyPath = options.workerRegistry.workerReadyPath(workerToken);
    // Defensively clear any stale ready file (shouldn't exist; token is fresh).
    try {
      await fs.unlink(readyPath);
    } catch {
      /* ignore */
    }

    const child = spawn(
      process.execPath,
      [
        options.supervisorScript,
        "--command",
        options.piCommand,
        "--cwd",
        options.cwd,
        "--args",
        JSON.stringify(options.args),
        "--runtime-dir",
        options.workerRegistry.runtimeDir,
        "--worker-token",
        workerToken,
      ],
      {
        cwd: options.cwd,
        env: process.env,
        stdio: "ignore",
        detached: true,
      },
    );
    child.unref();
    child.on("error", () => {
      /* surfaced via ready timeout below */
    });

    const ready = await waitForReadyFile(readyPath, 15_000);
    const socket = await connectSocket(ready.socketPath);
    const process_ = new SupervisedRpcProcess(socket);
    process_.socketPath = ready.socketPath;
    process_.observabilityContext.socketPath = ready.socketPath;
    await process_.handshake(null);
    // Best-effort cleanup of the transient ready file.
    fs.unlink(readyPath).catch(() => {});
    return process_;
  }

  static async connect(
    options: SupervisedConnectOptions,
  ): Promise<SupervisedRpcProcess> {
    const socket = await connectSocket(options.socketPath);
    const process_ = new SupervisedRpcProcess(socket);
    process_.socketPath = options.socketPath;
    process_.observabilityContext.socketPath = options.socketPath;
    await process_.handshake(options.resumeFromSeq);
    return process_;
  }

  onEvent(listener: (event: unknown, seq: number) => void): Unsubscribe {
    this.eventEmitter.on("event", listener);
    return () => this.eventEmitter.off("event", listener);
  }

  send(payload: Record<string, unknown>): void {
    if (this.closed) {
      // We deliberately do NOT auto-reopen for fire-and-forget send() because
      // there's no response correlation to wait on — the caller wouldn't know
      // if their payload made it. request() is the user-facing path that
      // matters; send() is rare (only used by respondToExtensionUi today).
      logRejectedHandleClosed(
        this,
        typeof payload?.type === "string" ? payload.type : "<send>",
      );
      throw new Error("Pi RPC supervisor connection is closed");
    }
    this.socket.write(JSON.stringify({ t: "rpc", data: payload }) + "\n");
  }

  async request(
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.closed) {
      // Auto-reconnect once per request before giving up. This is the FIX for
      // the 2026-05-24 silent-disconnect outage: the supervisor's UDS socket
      // can be evicted out from under us (e.g. currentClient eviction by an
      // openSession spawn-probe) without the supervisor process dying. In
      // that case the supervisor is still happily listening on its socket,
      // we just need to re-open ours. PR-A/B/C added the telemetry; this is
      // the actual fix.
      const reopened = await this.tryReopen(type);
      if (!reopened) {
        logRejectedHandleClosed(this, type);
        throw new Error("Pi RPC supervisor connection is closed");
      }
      // Successfully reopened. Fall through and issue the request below.
    }
    this.lastRequestType = type;
    const id = `pirpc-${this.nextId++}`;
    const message = { id, type, ...payload };
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(
        JSON.stringify({ t: "rpc", data: message }) + "\n",
        (error) => {
          if (!error) return;
          this.pending.delete(id);
          reject(error);
        },
      );
    });
    if (!response.success) throw new Error(response.error ?? `${type} failed`);
    // A successful round-trip proves the connection is healthy enough to
    // allow another reconnect attempt next time something breaks. Without
    // this, a single retry would burn the budget forever after the first
    // successful reopen.
    this.reopenAttempts = 0;
    return response.data;
  }

  /** Tell the supervisor to shut its pi child down. Used for explicit deletes. */
  async dispose(): Promise<void> {
    if (this.disposeRequested) return;
    this.disposeRequested = true;
    if (!this.closed) {
      try {
        this.socket.write(JSON.stringify({ t: "shutdown" }) + "\n");
      } catch {}
    }
    this.failAll(new Error("Pi RPC supervisor disposed"));
    await this.closeSocket();
  }

  /** Close the socket without shutting the supervisor down (API SIGTERM path). */
  async detach(): Promise<void> {
    this.detached = true;
    this.failAll(new Error("Pi RPC supervisor detached"));
    await this.closeSocket();
  }

  /** True when close() was driven by API-initiated dispose() or detach() */
  isIntentionalClose(): boolean {
    return this.disposeRequested || this.detached;
  }

  private async handshake(
    resumeFromSeq: number | null,
  ): Promise<SupervisorHelloAck> {
    const helloWritten = new Promise<void>((resolve, reject) => {
      this.socket.write(
        JSON.stringify({ t: "hello", resumeFromSeq }) + "\n",
        (err) => (err ? reject(err) : resolve()),
      );
    });
    await helloWritten;
    const ack = await this.waitForFrame(
      (frame) => isRecord(frame) && frame.t === "hello",
    );
    return ack as SupervisorHelloAck;
  }

  private waitForFrame(
    predicate: (frame: unknown) => boolean,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.off("frame", onFrame);
        this.off("close", onClose);
        reject(new Error("Timed out waiting for supervisor frame"));
      }, 10_000);
      const onFrame = (frame: unknown) => {
        if (!predicate(frame)) return;
        clearTimeout(deadline);
        this.off("frame", onFrame);
        this.off("close", onClose);
        resolve(frame);
      };
      const onClose = () => {
        clearTimeout(deadline);
        this.off("frame", onFrame);
        this.off("close", onClose);
        reject(new Error("Supervisor connection closed before frame arrived"));
      };
      this.on("frame", onFrame);
      this.on("close", onClose);
    });
  }

  // Tiny internal event bus.
  private internal = new EventEmitter();
  private on(event: "frame" | "close", listener: (...args: any[]) => void) {
    this.internal.on(event, listener);
  }
  private off(event: "frame" | "close", listener: (...args: any[]) => void) {
    this.internal.off(event, listener);
  }
  private emitInternal(event: "frame" | "close", ...args: unknown[]) {
    this.internal.emit(event, ...args);
  }

  private attachSocketHandlers(): void {
    // IMPORTANT: capture the socket reference at handler registration time.
    // After a reopen, this.socket will point at a NEW socket, but the OLD
    // socket will still fire its 'close' event as it tears down. The captured
    // ref lets us no-op for those stale close events instead of marking the
    // freshly-reopened connection as closed.
    const sock = this.socket;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      if (sock === this.socket) this.receive(chunk);
    });
    sock.on("error", (error) => {
      if (sock === this.socket) this.failAll(error);
    });
    sock.on("close", () => {
      // Stale: another socket has taken over (via reopen). Ignore.
      if (sock !== this.socket) return;
      const wasAlreadyClosed = this.closed;
      this.closed = true;
      if (this.closedAt === null) this.closedAt = Date.now();
      // Only emit the unexpected-close log line for the FIRST close (so a
      // detach/dispose followed by socket close doesn't double-log) and only
      // when neither dispose() nor detach() initiated it.
      if (!wasAlreadyClosed && !this.isIntentionalClose()) {
        logUnexpectedClose(this);
      }
      this.emitInternal("close");
      this.failAll(new Error("Pi RPC supervisor connection closed"));
    });
  }

  /**
   * Try to recover a closed handle by opening a fresh socket to the same
   * supervisor and re-running the hello/ack handshake with resumeFromSeq
   * set to our lastSeq (so the supervisor replays any events we missed
   * while disconnected). Returns true on success, false on failure.
   *
   * Idempotent / deduped: concurrent callers awaiting the same reopen
   * share the underlying promise. Intentional closes (dispose / detach)
   * are NEVER reopened.
   */
  private async tryReopen(requestType: string): Promise<boolean> {
    if (this.disposeRequested || this.detached) return false;
    if (!this.socketPath) return false; // can't reconnect without knowing where
    if (!this.closed) return true; // already healthy
    if (
      this.reopenAttempts >=
      SupervisedRpcProcess.RECONNECT_MAX_ATTEMPTS_PER_REQUEST
    ) {
      // Per-handle cap so we don't spin in a tight loop against a permanently
      // broken supervisor. Reset on each successful request (see below).
      return false;
    }
    if (this.reopening) return this.reopening;

    this.reopenAttempts += 1;
    const ctx = this.observabilityContext;
    const resumeFromSeq = this.lastSeq;
    logReopenAttempt(this, requestType);

    this.reopening = (async () => {
      try {
        const newSocket = await connectSocket(this.socketPath!);
        // Replace the socket FIRST so the old socket's close handler no-ops.
        const oldSocket = this.socket;
        this.socket = newSocket;
        // Clear closed flags so the new socket's handshake & subsequent
        // request can write through. Note: failAll() ran when the old socket
        // closed, so this.pending is already empty.
        this.closed = false;
        this.closedAt = null;
        this.buffer = "";
        this.attachSocketHandlers();
        // Tear down the old socket now that it can't affect us.
        try {
          oldSocket.destroy();
        } catch {
          /* ignore */
        }

        // Re-run the hello handshake. The supervisor's currentClient is
        // replaced by this new connection; resumeFromSeq tells it to backfill
        // missed ring events to our event listeners.
        await this.handshake(resumeFromSeq);
        logReopenSucceeded(this, requestType, resumeFromSeq);
        return true;
      } catch (err) {
        this.closed = true;
        if (this.closedAt === null) this.closedAt = Date.now();
        logReopenFailed(this, requestType, err);
        return false;
      } finally {
        this.reopening = null;
      }
    })();
    return this.reopening;
  }

  private async closeSocket(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.socket.once("close", done);
      try {
        this.socket.end();
      } catch {
        /* ignore */
      }
      // Don't wait for the supervisor's FIN — destroy promptly so detach is bounded.
      setTimeout(() => {
        try {
          this.socket.destroy();
        } catch {}
        done();
      }, 100).unref();
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      this.emitInternal("frame", parsed);
      this.dispatchFrame(parsed);
    }
  }

  private dispatchFrame(frame: unknown): void {
    if (!isRecord(frame)) return;
    if (frame.t === "hello") return; // handled by handshake
    if (frame.t === "resync") {
      // Inform consumers that they should refetch state. We surface as a
      // synthetic event so the registry-level ring can mark the resync point.
      this.eventEmitter.emit(
        "event",
        {
          type: "session_resync",
          fromSeq: frame.fromSeq,
          ringLowSeq: frame.ringLowSeq,
          lastSeq: frame.lastSeq,
        },
        typeof frame.lastSeq === "number" ? frame.lastSeq : this.lastSeq,
      );
      return;
    }
    if (frame.t === "event") {
      const seq = typeof frame.seq === "number" ? frame.seq : this.lastSeq + 1;
      this.lastSeq = seq;
      const data = frame.data;
      if (
        isRecord(data) &&
        data.type === "response" &&
        typeof data.id === "string"
      ) {
        const pending = this.pending.get(data.id);
        if (pending) {
          this.pending.delete(data.id);
          pending.resolve(data as unknown as RpcResponse);
        }
        // Don't surface responses as events to consumers; matches old behavior.
        return;
      }
      this.eventEmitter.emit("event", data, seq);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function waitForReadyFile(
  file: string,
  timeoutMs: number,
): Promise<{ sessionId: string; socketPath: string; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(text);
      if (
        parsed &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.socketPath === "string"
      ) {
        return parsed;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(50);
  }
  throw lastError instanceof Error
    ? new Error(`Pi RPC supervisor did not become ready: ${lastError.message}`)
    : new Error("Pi RPC supervisor did not become ready");
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Observability helpers (added 2026-05-24). These are structured-log shims
// that surface the silent "supervisor handle closed but nobody noticed"
// failure mode we hit in production. Both emit a single JSON line to stderr
// per event so an operator can `grep pirpc.handle.unexpected_close` (or
// pipe to a log aggregator) and see exactly which sessions broke and when.
//
// Why structured? Lets you `grep -E '"event":"pirpc.handle.unexpected_close"'`
// or jq your way through the API stderr without false positives from the
// surrounding human-readable log noise.
// ---------------------------------------------------------------------------

function logUnexpectedClose(rpc: SupervisedRpcProcess): void {
  const ctx = rpc.observabilityContext;
  const ageMs = (rpc.closedAt ?? Date.now()) - rpc.openedAt;
  const payload = {
    level: "warn",
    event: "pirpc.handle.unexpected_close",
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    supervisorPid: ctx.supervisorPid,
    socketPath: ctx.socketPath,
    ageMs,
    lastRequestType: rpc.lastRequestType,
  };
  // Use console.warn so it lands on stderr separately from regular console.log
  // output; one line per event keeps it grep-friendly.
  console.warn(JSON.stringify(payload));
}

function logReopenAttempt(
  rpc: SupervisedRpcProcess,
  requestType: string,
): void {
  const ctx = rpc.observabilityContext;
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "pirpc.handle.reopen_attempt",
      ts: new Date().toISOString(),
      sessionId: ctx.sessionId,
      supervisorPid: ctx.supervisorPid,
      socketPath: ctx.socketPath,
      requestType,
    }),
  );
}

function logReopenSucceeded(
  rpc: SupervisedRpcProcess,
  requestType: string,
  resumeFromSeq: number,
): void {
  const ctx = rpc.observabilityContext;
  console.warn(
    JSON.stringify({
      level: "info",
      event: "pirpc.handle.reopen_succeeded",
      ts: new Date().toISOString(),
      sessionId: ctx.sessionId,
      supervisorPid: ctx.supervisorPid,
      requestType,
      resumeFromSeq,
    }),
  );
}

function logReopenFailed(
  rpc: SupervisedRpcProcess,
  requestType: string,
  err: unknown,
): void {
  const ctx = rpc.observabilityContext;
  console.error(
    JSON.stringify({
      level: "error",
      event: "pirpc.handle.reopen_failed",
      ts: new Date().toISOString(),
      sessionId: ctx.sessionId,
      supervisorPid: ctx.supervisorPid,
      socketPath: ctx.socketPath,
      requestType,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

function logRejectedHandleClosed(
  rpc: SupervisedRpcProcess,
  requestType: string,
): void {
  const ctx = rpc.observabilityContext;
  const closedAt = rpc.closedAt ?? Date.now();
  const payload = {
    level: "error",
    event: "pirpc.request.rejected_handle_closed",
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    supervisorPid: ctx.supervisorPid,
    requestType,
    closedAgeMs: Date.now() - closedAt,
  };
  console.error(JSON.stringify(payload));
}
