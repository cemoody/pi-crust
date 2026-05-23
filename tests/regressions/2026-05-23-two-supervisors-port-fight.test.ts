/**
 * 2026-05-23 — two dev-api supervisors fighting for port 8787.
 *
 * Symptom: an orphan dev-api.mjs supervisor (PPID=1, started ~12h
 * earlier from a now-dead tty) held port 8787 via its child API. The
 * operator started a *second* dev:api:loop in the same tmux pane; the
 * new supervisor crash-looped silently every 2 s with `port 8787 on
 * 127.0.0.1 is already in use` and no information about who held it.
 *
 * Post-mortem in: docs/incidents.md (2026-05-23)
 *
 * Invariants we now enforce:
 *
 *   1. On EADDRINUSE, the supervisor logs the pid AND cwd AND cmdline
 *      of the existing port holder — enough for an operator to decide
 *      whether to kill it. "Already in use" alone is not enough.
 *   2. The crash-loop is rate-limited: after N consecutive EADDRINUSE
 *      exits the supervisor logs a "ELEVATING TO MANUAL" line at most
 *      once per 30 s, not on every retry.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnPortHolder } from "../helpers/process-tree.js";
import { spawnDevApi } from "../helpers/spawn-supervisor.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    try { await c(); } catch { /* best effort */ }
  }
});

function pickTestPort(): number {
  // Random 5-digit port in the unprivileged range, well above the
  // dev-server defaults we know about (5173, 5174, 8787, 8788, 8789).
  return 40_000 + Math.floor(Math.random() * 10_000);
}

describe("2026-05-23 two supervisors port fight", () => {
  it("identifies the holder pid + cmdline on EADDRINUSE", async () => {
    const port = pickTestPort();
    const holder = spawnPortHolder(port, "regression-test-holder");
    cleanups.push(() => { try { holder.child.kill("SIGKILL"); } catch { /* ignore */ } });
    await holder.ready;
    const holderPid = holder.child.pid!;

    // Run a synthetic child that tries to bind the same port. The
    // supervisor doesn't itself bind ports — it just runs its child.
    // We give it a tiny bash that uses node to try to bind, so EADDRINUSE
    // surfaces in the child's stderr; the supervisor's job is to enrich
    // it with the holder's identity on retry.
    const childScript = `
      import http from "node:http";
      const server = http.createServer();
      server.on("error", (err) => { process.stderr.write(\`bind failed: \${err.code}\\n\`); process.exit(2); });
      server.listen(${port}, "127.0.0.1");
    `;
    const childWrapper = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "port-collide-")), "child.mjs");
    cleanups.push(() => fs.rm(path.dirname(childWrapper), { recursive: true, force: true }));
    await fs.writeFile(childWrapper, childScript);

    const sup = spawnDevApi({
      cmd: [process.execPath, childWrapper],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "200", DEV_API_PORT_HINT: String(port) },
    });
    cleanups.push(sup.shutdown);

    // The child will crash. After several crashes the supervisor must
    // probe the listening port and log the holder's identity. The log
    // line shape is locked in tests/regressions/* deliberately so a
    // future log refactor can't silently drop the diagnostic.
    await sup.waitForLog((l) => {
      return new RegExp(`pid=${holderPid}`).test(l)
        && /port \d+ still held by/.test(l)
        && /cwd=/.test(l)
        && /cmd=/.test(l);
    }, 12_000);
  }, 20_000);

  it("rate-limits the EADDRINUSE elevation log to at most once per 30s", async () => {
    const port = pickTestPort();
    const holder = spawnPortHolder(port, "rate-limit-holder");
    cleanups.push(() => { try { holder.child.kill("SIGKILL"); } catch { /* ignore */ } });
    await holder.ready;

    const childScript = `
      import http from "node:http";
      const server = http.createServer();
      server.on("error", () => process.exit(2));
      server.listen(${port}, "127.0.0.1");
    `;
    const childWrapper = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "rate-limit-")), "child.mjs");
    cleanups.push(() => fs.rm(path.dirname(childWrapper), { recursive: true, force: true }));
    await fs.writeFile(childWrapper, childScript);

    const sup = spawnDevApi({
      cmd: [process.execPath, childWrapper],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "150", DEV_API_PORT_HINT: String(port) },
    });
    cleanups.push(sup.shutdown);

    // Let it churn for ~5s, which would be ~30+ crashes at 150ms backoff.
    await new Promise((r) => setTimeout(r, 5000));
    const elevations = (sup.log().match(/port \d+ still held by/g) ?? []).length;
    expect(elevations, "should rate-limit, not log on every single retry").toBeLessThanOrEqual(2);
    expect(elevations, "must log at least once though").toBeGreaterThanOrEqual(1);
  }, 15_000);
});
