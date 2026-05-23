/**
 * Black-box smoke: exercise the supervisor in its production shape
 * (`scripts/dev-api.mjs -- node -e "..."`) and verify the externally
 * observable contract end-to-end:
 *
 *   1. Spawns a child that listens on a port.
 *   2. The port becomes reachable within N seconds.
 *   3. SIGTERM to the supervisor cleanly stops the child.
 *   4. After shutdown, the port is free and no descendants survive.
 *
 * This is the "did npm/sh forward signals correctly?" canary. Unit
 * tests of dev-api.mjs cover the internals, but the npm-script chain
 * itself is a frequent regression site (see 2026-05-15 npm-doesn't-
 * forward-SIGTERM incident in docs/incidents.md).
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { spawnDevApi, type SupervisorHandle } from "../helpers/spawn-supervisor.js";
import {
  descendantsOf,
  isAlive,
  tcpListenersOnPort,
  waitFor,
  waitForPortFree,
} from "../helpers/process-tree.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) { try { await c(); } catch { /* ignore */ } }
});

function pickPort(): number { return 40_000 + Math.floor(Math.random() * 10_000); }

function httpProbe(port: number, timeoutMs = 1000): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

describe("smoke: dev-api lifecycle (port up, signals down)", () => {
  it("brings up an http server, takes SIGTERM, releases the port, leaves no orphans", async () => {
    const port = pickPort();
    const childScript = `
      import http from "node:http";
      const server = http.createServer((_, res) => { res.writeHead(200); res.end("ok"); });
      server.listen(${port}, "127.0.0.1");
      process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
    `;
    const sup: SupervisorHandle = spawnDevApi({
      cmd: [process.execPath, "--input-type=module", "-e", childScript],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "300", DEV_API_PORT_HINT: String(port) },
    });
    cleanups.push(sup.shutdown);
    // Port becomes reachable.
    await waitFor(async () => (await httpProbe(port)) === 200, {
      timeoutMs: 8000, label: `port ${port} responds 200`,
    });
    // Collect the descendants we expect to be cleaned up.
    const descendantsBefore = await descendantsOf(sup.proc.pid!, /* inclusive */ false);
    expect(descendantsBefore.length, "supervisor must actually have a child").toBeGreaterThanOrEqual(1);

    // Trigger graceful shutdown via SIGTERM.
    sup.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => sup.proc.once("exit", () => resolve()));
    // Port must be free.
    await waitForPortFree(port, 6000);
    // No descendant survives.
    for (const pid of descendantsBefore) {
      expect(isAlive(pid), `descendant pid ${pid} must be reaped after SIGTERM`).toBe(false);
    }
    // And no listener is left.
    expect((await tcpListenersOnPort(port)).length).toBe(0);
  }, 25_000);
});
