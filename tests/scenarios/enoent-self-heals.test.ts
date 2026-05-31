/**
 * Scenario (Feature B — self-healing registry):
 *
 *   Reproduces the 2026-05-29 "dead handle" class. A session is open and
 *   registered with the API. Its detached worker dies (crash / OOM / manual
 *   kill) and its unix socket goes away — but the API still holds a live
 *   registration pointing at that dead socket. Re-opening the session returns
 *   the stale handle and dials the dead socket, yielding:
 *
 *       500 "Pi RPC supervisor connection is closed"
 *       (or, with a missing socket file, connect ENOENT /tmp/.../<hash>.sock)
 *
 *   and it does NOT recover on subsequent opens — every open re-hits the dead
 *   handle. In production this manifested as a session that was permanently
 *   "unhealthy" until the whole API was bounced.
 *
 *   The robust contract we want (Feature B):
 *     - getOrOpenSession detects a dead/closed handle (pid not alive OR socket
 *       not connectable) and transparently RE-SPAWNS a fresh worker, returning
 *       200 — the session self-heals on next access.
 *     - the registry never serves a handle whose worker is gone.
 *     - no stale sockets are left with no listener.
 *
 * Expected status: RED until Feature B lands. This is the executable spec.
 *
 * Two sub-cases:
 *   A) API stays up, worker dies   → stale live registration (the core bug)
 *   B) API restarts after worker dies → reattach must reconcile, not re-dial
 */
import { afterEach, describe, expect, it } from "vitest";
import { startLiveStack, type LiveStack } from "../helpers/live-stack.js";

const stacks: LiveStack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) { try { await s.teardown(); } catch { /* ignore */ } }
});

describe("scenario: registry self-heals a dead worker", () => {
  it("A) API up, worker dies: reopening re-spawns instead of serving a dead handle", async () => {
    const stack = await startLiveStack({ label: "enoent-a" });
    stacks.push(stack);

    const sid = await stack.api.createSession();
    expect((await stack.api.openSession(sid)).status).toBe(200);
    expect((await stack.proc.workerPids()).length).toBeGreaterThanOrEqual(1);

    // Kill ONLY the worker. API keeps its (now dead) registration.
    await stack.proc.killWorker(sid);
    await new Promise((r) => setTimeout(r, 500));
    expect(await stack.proc.workerPids()).toEqual([]);

    // The bug: 500 "connection is closed" / ENOENT, and it never recovers.
    // The contract: self-heal to 200 by re-spawning the worker.
    const reopen = await stack.api.openSession(sid);
    expect(reopen.status, `reopen body: ${JSON.stringify(reopen.body)}`).toBe(200);

    // A second open must also be healthy (no lingering dead handle).
    expect((await stack.api.openSession(sid)).status).toBe(200);

    await stack.assert.noStaleSockets();
    await stack.assert.sessionsHealthy();
  });

  it("B) API restarts after worker death: reattach reconciles, reopen is clean", async () => {
    const stack = await startLiveStack({ label: "enoent-b" });
    stacks.push(stack);

    const sid = await stack.api.createSession();
    expect((await stack.api.openSession(sid)).status).toBe(200);

    await stack.proc.killWorker(sid);
    await stack.proc.killApiChild();
    await stack.waitForApi();

    await stack.api.listSessions(); // prime cold-session discovery
    const reopen = await stack.api.openSession(sid);
    expect(reopen.status, `reopen body: ${JSON.stringify(reopen.body)}`).toBe(200);

    await stack.assert.noStaleSockets();
  });
});
