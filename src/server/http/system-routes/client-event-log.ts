import fs from "node:fs/promises";
import path from "node:path";

/** Bounded telemetry accepted from browser clients on POST /api/client-event. */
export const CLIENT_EVENT_MAX_BYTES = 16 * 1024;
export const CLIENT_EVENT_RING_CAPACITY = 4096;

export interface ClientEventStats {
  readonly windowMs: number;
  readonly total: number;
  readonly bufferDropped: number;
  readonly byKind: Record<string, number>;
  readonly byApiErrorStatus: Record<string, number>;
  readonly topSessions: Array<{ sessionId: string; count: number }>;
  readonly topApiErrorPaths: Array<{ path: string; count: number }>;
}

/** Durable append log with a bounded, in-memory operator-statistics view. */
export interface ClientEventLog {
  append(payload: Record<string, unknown>): Promise<void>;
  stats(windowMs: number): ClientEventStats;
}

export function createClientEventLog(filePath: string): ClientEventLog {
  let queue: Promise<void> = Promise.resolve();
  const ring: Array<{ ts: number; payload: Record<string, unknown> } | undefined> = new Array(CLIENT_EVENT_RING_CAPACITY);
  let ringHead = 0;
  let totalAppended = 0;
  return {
    append(payload) {
      const ts = typeof payload.serverTs === "number" ? payload.serverTs : Date.now();
      ring[ringHead] = { ts, payload };
      ringHead = (ringHead + 1) % CLIENT_EVENT_RING_CAPACITY;
      totalAppended += 1;
      queue = queue.then(async () => {
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
        } catch (error) {
          console.warn(`client-event log append failed: ${error instanceof Error ? error.message : error}`);
        }
      });
      return queue;
    },
    stats(windowMs) {
      return summarizeClientEventRing(ring, windowMs, totalAppended);
    },
  };
}

/**
 * Aggregate a telemetry ring without touching disk. This is deliberately pure
 * so the HTTP route contract and durable log lifecycle remain independently
 * testable.
 */
export function summarizeClientEventRing(
  ring: ReadonlyArray<{ ts: number; payload: Record<string, unknown> } | undefined>,
  windowMs: number,
  totalAppended: number,
): ClientEventStats {
  const cutoff = Date.now() - windowMs;
  const byKind: Record<string, number> = {};
  const byApiErrorStatus: Record<string, number> = {};
  const sessionCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  let total = 0;
  for (const slot of ring) {
    if (!slot || slot.ts < cutoff) continue;
    total += 1;
    const kind = typeof slot.payload.kind === "string" ? slot.payload.kind : "<unknown>";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const sessionId = typeof slot.payload.sessionId === "string" ? slot.payload.sessionId : null;
    if (sessionId) sessionCounts.set(sessionId, (sessionCounts.get(sessionId) ?? 0) + 1);
    if (kind === "api-error") {
      const status = String(slot.payload.status ?? "unknown");
      byApiErrorStatus[status] = (byApiErrorStatus[status] ?? 0) + 1;
      const requestPath = typeof slot.payload.path === "string" ? slot.payload.path : null;
      if (requestPath) pathCounts.set(requestPath, (pathCounts.get(requestPath) ?? 0) + 1);
    }
  }
  return {
    windowMs,
    total,
    bufferDropped: Math.max(0, totalAppended - CLIENT_EVENT_RING_CAPACITY),
    byKind,
    byApiErrorStatus,
    topSessions: [...sessionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sessionId, count]) => ({ sessionId, count })),
    topApiErrorPaths: [...pathCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([requestPath, count]) => ({ path: requestPath, count })),
  };
}
