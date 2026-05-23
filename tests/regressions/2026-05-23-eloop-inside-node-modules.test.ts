/**
 * 2026-05-23 — 33-minute outage caused by ELOOP *inside* node_modules.
 *
 * Symptom: dev-api.mjs supervisor crash-looped on `spawn ELOOP` every
 * ~820 ms for 33 minutes. The auto-heal (`tryHealCyclicNodeModules`) did
 * not trigger because it only handled the case where `node_modules`
 * itself is a self-referential symlink. The actual ELOOP today was on
 * `node_modules/.bin/tsx` (or a nested dir under node_modules/tsx),
 * which the heuristic missed entirely.
 *
 * Post-mortem in: docs/incidents.md (2026-05-23)
 *
 * Invariant we now enforce:
 *
 *   When dev-api.mjs hits `spawn ELOOP`, it MUST detect *any* cyclic
 *   symlink inside node_modules and trigger the heal — not just the
 *   "node_modules is itself a symlink" case.
 */

import { afterEach, describe, expect, it } from "vitest";
import { makeCyclicNodeModules } from "../helpers/fs-chaos.js";
import { spawnDevApi, type SupervisorHandle } from "../helpers/spawn-supervisor.js";
import fs from "node:fs/promises";
import path from "node:path";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    try { await c(); } catch { /* best effort */ }
  }
});

describe("2026-05-23 ELOOP inside node_modules", () => {
  it("heals when node_modules/.bin/tsx is a self-symlink", async () => {
    const sandbox = await makeCyclicNodeModules({ variant: "nested-bin" });
    cleanups.push(sandbox.cleanup);
    // Copy dev-api.mjs into the sandbox so its projectRoot probes
    // the sandbox's node_modules and not the real pi-crust tree.
    const scriptInSandbox = path.join(sandbox.root, "scripts", "dev-api.mjs");
    await fs.mkdir(path.dirname(scriptInSandbox), { recursive: true });
    await fs.copyFile(path.resolve(__dirname, "..", "..", "scripts", "dev-api.mjs"), scriptInSandbox);
    // Need src/server to exist for the watcher's startWatcher() not to throw.
    await fs.mkdir(path.join(sandbox.root, "src", "server"), { recursive: true });

    const sup: SupervisorHandle = spawnDevApi({
      cmd: [sandbox.tsxBin, "--version"],
      cwd: sandbox.root,
      scriptPath: scriptInSandbox,
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "200" },
    });
    cleanups.push(sup.shutdown);

    // The bug we're testing: before the heal landed, the supervisor
    // would log "Will retry" forever without ever running the heal.
    // After the heal (PR #125 shipped the unconditional-npm-install
    // approach with a 30s cooldown), the supervisor must surface a
    // 'running npm install' line when nested symlinks are the
    // culprit — anything else means we've regressed back to the
    // opaque-spin state.
    await sup.waitForLog((l) =>
      /running .*npm install/.test(l),
      15_000,
    );

    // Whether the heal actually unlinks the cyclic symlink depends on
    // the heal strategy (#125 only runs npm install, so a .bin/tsx
    // self-symlink remains until npm relinks it via a tsx dep). What
    // we lock down here is the ACTIONABLE LOG: "running npm install"
    // must be present, and the cooldown line must follow on subsequent
    // attempts so the operator can see we're not just spinning blind.
    await sup.waitForLog((l) => /heal cooldown active|npm install completed/.test(l), 10_000);
  }, 30_000);

  it("a self-symlinked node_modules root triggers the case-A heal path", async () => {
    // Variant 'self' is the original 2026-05-23 morning incident shape:
    // `node_modules -> ../<self>/node_modules`. The heal must detect
    // the cyclic symlink, unlink it, and run npm install. We need our
    // own dev-api copy in the sandbox so projectRoot resolves there.
    const sandbox = await makeCyclicNodeModules({ variant: "self" });
    cleanups.push(sandbox.cleanup);
    const scriptInSandbox = path.join(sandbox.root, "scripts", "dev-api.mjs");
    await fs.mkdir(path.dirname(scriptInSandbox), { recursive: true });
    await fs.copyFile(path.resolve(__dirname, "..", "..", "scripts", "dev-api.mjs"), scriptInSandbox);
    await fs.mkdir(path.join(sandbox.root, "src", "server"), { recursive: true });

    const sup = spawnDevApi({
      cmd: [path.join(sandbox.root, "node_modules", ".bin", "tsx"), "--version"],
      cwd: sandbox.root,
      scriptPath: scriptInSandbox,
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "200" },
    });
    cleanups.push(sup.shutdown);

    await sup.waitForLog((l) =>
      /detected cyclic node_modules symlink/.test(l)
      && /Removing before npm install/.test(l),
      15_000,
    );
  }, 25_000);
});
