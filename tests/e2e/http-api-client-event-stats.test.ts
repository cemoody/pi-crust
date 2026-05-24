/**
 * E2E test for GET /api/client-event/stats (PR-C of the 2026-05-24
 * observability series).
 *
 * Posts a representative set of telemetry events to /api/client-event,
 * then verifies that /api/client-event/stats returns histograms that
 * surface the 2026-05-24 outage signature (many api-error+500s on a few
 * sessions).
 */

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("GET /api/client-event/stats", () => {
  it("returns empty histograms when no client events have been posted", async () => {
    const { baseUrl } = await makeServer();
    const stats = await fetchJson<{ total: number; byKind: Record<string, number> }>(`${baseUrl}/api/client-event/stats`);
    expect(stats.total).toBe(0);
    expect(stats.byKind).toEqual({});
  });

  it("aggregates a burst of api-error events into byKind / byApiErrorStatus / topSessions / topApiErrorPaths", async () => {
    const { baseUrl } = await makeServer();

    // Simulate the 2026-05-24 outage: 5 sessions each hitting /state and
    // /messages with HTTP 500. (We use 5 instead of 13 to keep the test
    // fast; the aggregator's behaviour scales.)
    for (let i = 0; i < 5; i++) {
      for (const endpoint of ["state", "messages"]) {
        await postEvent(baseUrl, {
          kind: "api-error",
          method: "GET",
          path: `/api/sessions/sid-${i}/${endpoint}`,
          status: 500,
          sessionId: `sid-${i}`,
          errorPreview: "Pi RPC supervisor connection is closed",
        });
      }
    }
    // Plus a couple of sse-silence events from the matching tabs.
    for (let i = 0; i < 3; i++) {
      await postEvent(baseUrl, { kind: "sse-silence", sessionId: `sid-${i}`, idleMs: 35_000 });
    }
    // Plus an unrelated 404 that should NOT pollute the topApiErrorPaths.
    await postEvent(baseUrl, { kind: "api-error", method: "GET", path: "/api/legacy", status: 404, sessionId: "sid-legacy" });

    const stats = await fetchJson<{
      total: number;
      byKind: Record<string, number>;
      byApiErrorStatus: Record<string, number>;
      topSessions: Array<{ sessionId: string; count: number }>;
      topApiErrorPaths: Array<{ path: string; count: number }>;
    }>(`${baseUrl}/api/client-event/stats?windowMs=60000`);

    expect(stats.total).toBe(5 * 2 + 3 + 1);
    expect(stats.byKind["api-error"]).toBe(11);
    expect(stats.byKind["sse-silence"]).toBe(3);
    expect(stats.byApiErrorStatus["500"]).toBe(10);
    expect(stats.byApiErrorStatus["404"]).toBe(1);

    // topSessions: each sid-0..sid-2 has 3 events (2 api-error + 1 silence),
    // sid-3 and sid-4 have 2 each. So the top should have count=3 first.
    expect(stats.topSessions[0]?.count).toBe(3);

    // topApiErrorPaths should be dominated by the /state and /messages paths.
    const topPaths = stats.topApiErrorPaths.map((p) => p.path);
    expect(topPaths.some((p) => p.endsWith("/state"))).toBe(true);
    expect(topPaths.some((p) => p.endsWith("/messages"))).toBe(true);
  });

  it("clamps windowMs to a reasonable range (no negative, no absurdly large)", async () => {
    const { baseUrl } = await makeServer();
    // Negative gets clamped to the minimum (1000 ms).
    const negStats = await fetchJson<{ windowMs: number }>(`${baseUrl}/api/client-event/stats?windowMs=-99999`);
    expect(negStats.windowMs).toBeGreaterThanOrEqual(1_000);
    // Way too large gets clamped to the maximum (1 h).
    const bigStats = await fetchJson<{ windowMs: number }>(`${baseUrl}/api/client-event/stats?windowMs=999999999999`);
    expect(bigStats.windowMs).toBeLessThanOrEqual(60 * 60_000);
  });

  it("returns empty stats when clientEventLog is not configured on the server", async () => {
    const { baseUrl } = await makeServer({ enableClientEventLog: false });
    const stats = await fetchJson<{ total: number }>(`${baseUrl}/api/client-event/stats`);
    expect(stats.total).toBe(0);
  });
});

async function makeServer(opts: { enableClientEventLog?: boolean } = {}): Promise<{ baseUrl: string; eventLogPath?: string }> {
  const enableLog = opts.enableClientEventLog ?? true;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-client-event-stats-"));
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const eventLogPath = enableLog ? path.join(root, "logs", "client-events.jsonl") : undefined;
  const server = createHttpApiServer({
    registry,
    adapterKind: "test",
    projectRoot,
    sessionRoot,
    defaultCwd: projectRoot,
    ...(eventLogPath ? { clientEventLogPath: eventLogPath } : {}),
  });
  servers.push(server);
  const baseUrl = await listen(server);
  return eventLogPath ? { baseUrl, eventLogPath } : { baseUrl };
}

async function postEvent(baseUrl: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/api/client-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /api/client-event returned ${res.status}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
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
