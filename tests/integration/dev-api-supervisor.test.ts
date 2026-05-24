/**
 * Integration test for scripts/dev-api.mjs.
 *
 * These tests pin the invariants that distinguish this supervisor from
 * the old `tsx watch` default:
 *
 *   1. On file change in src/server, the running child gets SIGTERM and
 *      a new child is spawned (the self-edit happy path).
 *   2. If the child crashes during startup (simulating tsx hitting a
 *      mid-pull corrupt package.json), the supervisor does NOT hang — it
 *      respawns on the configured backoff. This is THE bug `tsx watch`
 *      had: it stayed alive waiting for the next file event, leaving the
 *      api down indefinitely.
 *   3. A burst of file changes (mimics a git pull's multi-file rewrite)
 *      coalesces into a single restart, not N.
 *   4. SIGTERM on file-change kills the child's ENTIRE process group, not
 *      just the immediate child. The real-world consequence of getting
 *      this wrong: `npm run dev:api` is the immediate child, but doesn't
 *      forward SIGTERM to its sh→tsx→node descendants, so npm exits and
 *      orphans the actual http-api-server process. The orphan keeps
 *      holding port 8787, every subsequent respawn fails EADDRINUSE, the
 *      supervisor enters a permanent crash-loop. Observed in the wild on
 *      2026-05-15.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
// (spawn is used both for startSupervisor below and the auto-heal test)
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(__dirname, "../../scripts/dev-api.mjs");
const projectRoot = path.resolve(__dirname, "../..");

let supervisor: ChildProcess | null = null;
let watchedFiles: string[] = [];
const logChunks: string[] = [];

afterEach(async () => {
  // Reap the supervisor. The supervisor's own SIGTERM handler is
  // responsible for signalling its detached child process group; we just
  // need to give it a moment to do so before escalating to SIGKILL.
  //
  // Why this matters: the supervisor spawns its child with detached:true,
  // making the child its own pgroup leader. SIGKILL'ing the supervisor
  // handle does NOT cascade to the child group — the child outlives the
  // supervisor as a true orphan. SIGTERM gives the supervisor a chance
  // to run shutdown() (which calls killGroup(child.pid, "SIGTERM") and
  // then SIGKILL). Process-hygiene guard catches any survivors anyway.
  if (supervisor && supervisor.exitCode === null && !supervisor.killed) {
    try { supervisor.kill("SIGTERM"); } catch { /* already dead */ }
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => supervisor!.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (!exited) {
      try { supervisor.kill("SIGKILL"); } catch { /* already dead */ }
      await new Promise<void>((resolve) => supervisor!.once("exit", () => resolve()));
    }
  }
  supervisor = null;
  for (const f of watchedFiles) {
    try { await fs.unlink(f); } catch { /* may already be gone */ }
  }
  watchedFiles = [];
  logChunks.length = 0;
});

interface SupOptions {
  /** Child command argv (e.g. ["bash","-c","..."]). */
  cmd: string[];
  /** Optional env overrides for the supervisor (DEV_API_DEBOUNCE_MS etc). */
  env?: Record<string, string>;
}

function startSupervisor(opts: SupOptions): Promise<void> {
  return new Promise((resolve) => {
    supervisor = spawn(process.execPath, [scriptPath, "--", ...opts.cmd], {
      cwd: projectRoot,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervisor.stdout!.on("data", (chunk) => logChunks.push(chunk.toString()));
    supervisor.stderr!.on("data", (chunk) => logChunks.push(chunk.toString()));
    // Give it a beat to print its initial "spawned" + "watching" lines.
    setTimeout(resolve, 200);
  });
}

function fullLog(): string {
  return logChunks.join("");
}

async function waitForLog(predicate: (log: string) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(fullLog())) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForLog timed out. Saw:\n${fullLog()}`);
}

async function writeWatched(rel: string, content: string): Promise<void> {
  const abs = path.join(projectRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  watchedFiles.push(abs);
}

describe("dev-api.mjs supervisor", () => {
  it("SIGTERMs the child and respawns when a file under src/server changes", async () => {
    await startSupervisor({
      // A child that runs forever and traps SIGTERM cleanly.
      cmd: ["bash", "-c", 'echo "child up pid=$$"; trap "echo child got TERM; exit 0" TERM; while true; do sleep 1; done'],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "300" },
    });
    await waitForLog((l) => /spawned pid=\d+/.test(l));
    const firstSpawnMatch = fullLog().match(/spawned pid=(\d+)/);
    expect(firstSpawnMatch, "first spawn line").toBeTruthy();

    await writeWatched(`src/server/__supervisor_test_${process.pid}.ts`, "// change");
    await waitForLog((l) => /change detected/.test(l));
    await waitForLog((l) => (l.match(/spawned pid=\d+/g) ?? []).length >= 2);

    const spawns = fullLog().match(/spawned pid=(\d+)/g) ?? [];
    expect(spawns.length, "expected exactly 2 spawn lines (initial + 1 restart)").toBe(2);
  }, 15_000);

  it("respawns the child after a crash-on-startup (the bug `tsx watch` had)", async () => {
    // Child that exits immediately with code 1. With tsx watch this leaves
    // the supervisor hung; here the supervisor should churn respawns.
    await startSupervisor({
      cmd: ["bash", "-c", 'echo "boot, will crash"; exit 1'],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "150" },
    });
    // Wait for at least 3 spawn lines (initial + 2 respawns) within 2.5s.
    await waitForLog((l) => (l.match(/spawned pid=\d+/g) ?? []).length >= 3, 3_000);

    const spawns = fullLog().match(/spawned pid=\d+/g) ?? [];
    expect(spawns.length).toBeGreaterThanOrEqual(3);

    // Importantly: every spawn was followed by an exit (the supervisor is
    // not stuck waiting for a child to come up).
    const exits = fullLog().match(/child pid=\d+ exited/g) ?? [];
    expect(exits.length, "every spawn should be paired with an exit log line").toBeGreaterThanOrEqual(spawns.length - 1);
  }, 8_000);

  it("coalesces a burst of file changes into a single restart (git-pull race)", async () => {
    await startSupervisor({
      cmd: ["bash", "-c", 'echo "child up"; trap "exit 0" TERM; while true; do sleep 1; done'],
      env: { DEV_API_DEBOUNCE_MS: "300", DEV_API_RESTART_MS: "300" },
    });
    await waitForLog((l) => /spawned pid=\d+/.test(l));

    // Write 16 files in rapid succession, mimicking a git pull bringing in
    // a multi-file PR.
    const burstDir = path.join(projectRoot, "src", "server", `__burst_${process.pid}`);
    await fs.mkdir(burstDir, { recursive: true });
    const filesToCleanup: string[] = [];
    for (let i = 0; i < 16; i++) {
      const f = path.join(burstDir, `f${i}.ts`);
      await fs.writeFile(f, `// burst ${i}`);
      filesToCleanup.push(f);
    }
    watchedFiles.push(...filesToCleanup);

    // Wait long enough for any belated change events to settle past the
    // debounce window.
    await new Promise((r) => setTimeout(r, 1500));

    const changeDetected = (fullLog().match(/change detected/g) ?? []).length;
    expect(changeDetected, "burst should coalesce into 1 (or at most 2) restart triggers").toBeLessThanOrEqual(2);
    expect(changeDetected, "but it must have triggered at least one").toBeGreaterThanOrEqual(1);

    // Cleanup the burst dir.
    await fs.rm(burstDir, { recursive: true, force: true });
  }, 15_000);

  it("SIGTERM on file change kills the child's whole process group (no orphaned grandchildren)", async () => {
    // Spawn a wrapper script that forks an inner child but does NOT forward
    // SIGTERM — the same behavior npm has by default. If our supervisor only
    // signaled the immediate child, the inner child would survive and keep
    // holding ports / file locks. The fix is `detached: true` + `kill(-pid)`.
    const wrapper = path.join(projectRoot, `__pgroup_wrapper_${process.pid}.sh`);
    await fs.writeFile(wrapper, [
      "#!/bin/bash",
      // inner child sleeps forever, ignoring SIGTERM. If only the wrapper
      // were signaled, this inner child would survive the restart.
      "bash -c 'trap : TERM; while true; do sleep 1; done' &",
      "inner=$!",
      "echo OUTER_PID=$$ INNER_PID=$inner",
      // Outer exits when its 'wait' is interrupted by a signal it doesn't
      // forward — mimicking npm's behavior on SIGTERM.
      "wait",
      "",
    ].join("\n"));
    await fs.chmod(wrapper, 0o755);
    watchedFiles.push(wrapper);

    await startSupervisor({
      cmd: [wrapper],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "300" },
    });
    await waitForLog((l) => /OUTER_PID=\d+ INNER_PID=\d+/.test(l));
    const m = fullLog().match(/OUTER_PID=(\d+) INNER_PID=(\d+)/);
    expect(m).toBeTruthy();
    const outerPid = m?.[1];
    const innerPid = m?.[2];
    expect(outerPid).toBeTruthy();
    expect(innerPid).toBeTruthy();

    // Trigger a watcher-driven restart.
    await writeWatched(`src/server/__pgroup_trigger_${process.pid}.ts`, "// change");
    await waitForLog((l) => /change detected/.test(l));
    // Give the supervisor's SIGTERM time to land on the group.
    await new Promise((r) => setTimeout(r, 1500));

    // BOTH the wrapper AND its inner grandchild should be gone.
    const isAlive = (pid: string | undefined) => {
      if (!pid) return false;
      try { process.kill(Number(pid), 0); return true; } catch { return false; }
    };
    expect(isAlive(outerPid), `outer pid ${outerPid} should be gone`).toBe(false);
    expect(isAlive(innerPid), `inner grandchild pid ${innerPid} should be gone (process-group kill)`).toBe(false);
  }, 12_000);

  it("ignores test files so editing a *.test.ts doesn't bounce the api", async () => {
    await startSupervisor({
      cmd: ["bash", "-c", 'echo "child up"; trap "exit 0" TERM; while true; do sleep 1; done'],
      env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "200" },
    });
    await waitForLog((l) => /spawned pid=\d+/.test(l));
    const initialSpawns = (fullLog().match(/spawned pid=\d+/g) ?? []).length;

    // Write a TEST file under src/server — should NOT trigger a restart.
    await writeWatched(`src/server/__ignore.test_${process.pid}.test.ts`, "// test change");
    await new Promise((r) => setTimeout(r, 700));

    const laterSpawns = (fullLog().match(/spawned pid=\d+/g) ?? []).length;
    expect(laterSpawns).toBe(initialSpawns);
    expect(fullLog()).not.toMatch(/change detected/);
  }, 8_000);

  it("survives a synchronous spawn() failure (ELOOP / ENOENT) and keeps retrying instead of crashing", async () => {
    // The exact failure mode observed on the dev box: a cyclic symlink in
    // node_modules (or any other broken binary lookup) makes spawn() throw
    // synchronously with ELOOP / ENOENT. Before this guard, the throw
    // escaped scripts/dev-api.mjs entirely and the whole npm-run-dev:api:loop
    // chain died with no respawn — the api stayed down indefinitely.
    //
    // We simulate by pointing the supervisor at a self-referencing symlink
    // (always ELOOP on resolve).
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-api-eloop-"));
    const cyclic = path.join(tmpDir, "loopme");
    await fs.symlink(cyclic, cyclic);
    try {
      await startSupervisor({
        cmd: [cyclic],
        env: { DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "150" },
      });
      // Wait for at least 3 spawn attempts — we want to prove the
      // supervisor keeps looping rather than dying on the first throw.
      await waitForLog((l) => (l.match(/spawn\(\) threw synchronously/g) ?? []).length >= 3, 4_000);

      const throws = (fullLog().match(/spawn\(\) threw synchronously/g) ?? []).length;
      expect(throws).toBeGreaterThanOrEqual(3);

      // Crucially: the supervisor process itself must still be alive
      // and running, NOT exited from an unhandled exception. Test
      // afterEach kills it, so we just check the child handle.
      expect(supervisor?.killed).toBeFalsy();
      expect(supervisor?.exitCode).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);

  it("auto-heals a cyclic node_modules symlink in the worktree it's spawning into", async () => {
    // Reproduces the recurring 'agent ran `ln -s ../pi-crust/node_modules
    // node_modules` from inside the canonical worktree' bug. We:
    //
    //   1. Build a self-contained sandbox worktree with its own minimal
    //      package.json + scripts/dev-api.mjs (so tryHealCyclicNodeModules
    //      runs `npm install` in the sandbox, not in pi-crust itself).
    //   2. Plant the cyclic symlink at sandbox/node_modules.
    //   3. Start the supervisor pointed at a binary path that lives under
    //      node_modules — spawn() will throw ELOOP synchronously.
    //   4. Assert the supervisor logs the heal, deletes the symlink, runs
    //      `npm install`, and the cyclic symlink is gone afterwards.
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dev-api-autoheal-"));
    try {
      // Minimal package.json (no deps) so `npm install` is a fast no-op.
      await fs.writeFile(path.join(sandbox, "package.json"), JSON.stringify({
        name: "dev-api-autoheal-sandbox",
        version: "0.0.0",
        private: true,
        type: "module",
      }, null, 2) + "\n");
      // Copy the supervisor into the sandbox so projectRoot resolves to
      // the sandbox (the heal logic uses projectRoot to locate node_modules).
      await fs.mkdir(path.join(sandbox, "scripts"), { recursive: true });
      await fs.mkdir(path.join(sandbox, "src/server"), { recursive: true });
      await fs.copyFile(scriptPath, path.join(sandbox, "scripts/dev-api.mjs"));
      // Plant the cyclic node_modules symlink: target = same path.
      const cyclicNm = path.join(sandbox, "node_modules");
      await fs.symlink(cyclicNm, cyclicNm);

      // Spawn the supervisor as a SANDBOX-rooted process so its projectRoot
      // is the sandbox (not the real pi-crust repo). We bypass startSupervisor
      // because it hard-codes REPO_ROOT.
      // The child command must resolve THROUGH node_modules so the
      // cyclic symlink triggers spawn ELOOP — same shape as the real
      // 'npm run dev:api' → 'node_modules/.bin/tsx ...' lookup that hit
      // this in production. Pointing at a non-existent path under the
      // cyclic node_modules trips ELOOP synchronously.
      const sandboxSupervisor = spawn(process.execPath, [
        path.join(sandbox, "scripts/dev-api.mjs"),
        "--",
        path.join(sandbox, "node_modules/.bin/tsx"),
        "--version",
      ], { cwd: sandbox, env: { ...process.env, DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "200" }, stdio: ["ignore", "pipe", "pipe"] });
      supervisor = sandboxSupervisor;
      const localLog: string[] = [];
      sandboxSupervisor.stdout!.on("data", (c) => localLog.push(c.toString()));
      sandboxSupervisor.stderr!.on("data", (c) => localLog.push(c.toString()));

      // Wait for the heal cycle to complete: ELOOP detected, symlink removed,
      // npm install run, success message logged.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (/detected cyclic node_modules symlink/.test(localLog.join(""))
            && /npm install completed|next respawn will retry the heal/.test(localLog.join(""))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const out = localLog.join("");
      expect(out, "should detect the cycle").toMatch(/detected cyclic node_modules symlink/);
      expect(out, "should run npm install").toMatch(/running .*npm install/);
      expect(out, "npm install should complete OR retry").toMatch(/npm install completed|next respawn will retry the heal/);

      // The bad symlink should be gone now (npm install replaced it with a real dir).
      const stillSymlink = await fs.lstat(cyclicNm).then((s) => s.isSymbolicLink()).catch(() => false);
      expect(stillSymlink, "the cyclic symlink should have been removed by the heal").toBe(false);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }, 25_000);

  it("auto-heals a node_modules whose nested symlink ELOOPs (e.g. node_modules/.bin/tsx → self)", async () => {
    // Reproduces the 2026-05-23 outage: `node_modules` was a real directory
    // (not itself a symlink), but a path INSIDE it self-referenced and
    // ELOOPed. The previous heal bailed at `!stat.isSymbolicLink()` and
    // the supervisor sat in 'Will retry' for 33 minutes with no API up.
    // The fix: when spawn() throws ELOOP and node_modules is a directory,
    // run `npm install` anyway (it's idempotent and repairs nested junk).
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dev-api-autoheal-nested-"));
    try {
      await fs.writeFile(path.join(sandbox, "package.json"), JSON.stringify({
        name: "dev-api-autoheal-nested-sandbox",
        version: "0.0.0",
        private: true,
        type: "module",
      }, null, 2) + "\n");
      await fs.mkdir(path.join(sandbox, "scripts"), { recursive: true });
      await fs.mkdir(path.join(sandbox, "src/server"), { recursive: true });
      await fs.copyFile(scriptPath, path.join(sandbox, "scripts/dev-api.mjs"));

      // Real node_modules dir; bad symlink NESTED inside it.
      await fs.mkdir(path.join(sandbox, "node_modules/.bin"), { recursive: true });
      const cyclicBin = path.join(sandbox, "node_modules/.bin/tsx");
      await fs.symlink(cyclicBin, cyclicBin); // tsx -> tsx

      const sandboxSupervisor = spawn(process.execPath, [
        path.join(sandbox, "scripts/dev-api.mjs"),
        "--",
        cyclicBin,
        "--version",
      ], { cwd: sandbox, env: { ...process.env, DEV_API_DEBOUNCE_MS: "200", DEV_API_RESTART_MS: "200" }, stdio: ["ignore", "pipe", "pipe"] });
      supervisor = sandboxSupervisor;
      const localLog: string[] = [];
      sandboxSupervisor.stdout!.on("data", (c) => localLog.push(c.toString()));
      sandboxSupervisor.stderr!.on("data", (c) => localLog.push(c.toString()));

      // Crucial: assert the heal RUNS even though node_modules itself isn't
      // a symlink. Before the fix this would log nothing and the supervisor
      // would just respawn forever.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const out = localLog.join("");
        if (/running .*npm install/.test(out)
            && /npm install completed|next respawn will retry the heal/.test(out)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const out = localLog.join("");
      expect(out, "spawn should have ELOOPed").toMatch(/spawn\(\) threw synchronously: .*ELOOP/);
      expect(out, "heal must run npm install even when node_modules isn't a symlink").toMatch(/running .*npm install/);
      expect(out, "npm install should complete OR be queued for retry").toMatch(/npm install completed|next respawn will retry the heal/);
      // We do NOT assert the heal removed the nested bad symlink; `npm install`
      // with no deps won't touch arbitrary user-created files under .bin.
      // What we DO assert is that the heal ran at all — that's the regression
      // guard for the 33-minute outage.
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }, 25_000);

  it("respects the heal cooldown so repeated ELOOP doesn't run npm install in a tight loop", async () => {
    // If npm install can't fix the breakage (e.g. permission errors, network
    // down, fundamentally broken filesystem), we mustn't spawn `npm install`
    // every ~1s forever. The cooldown ensures at most one heal attempt per
    // HEAL_COOLDOWN_MS window.
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dev-api-cooldown-"));
    try {
      await fs.writeFile(path.join(sandbox, "package.json"), JSON.stringify({
        name: "dev-api-cooldown-sandbox",
        version: "0.0.0",
        private: true,
        type: "module",
      }, null, 2) + "\n");
      await fs.mkdir(path.join(sandbox, "scripts"), { recursive: true });
      await fs.mkdir(path.join(sandbox, "src/server"), { recursive: true });
      await fs.copyFile(scriptPath, path.join(sandbox, "scripts/dev-api.mjs"));
      await fs.mkdir(path.join(sandbox, "node_modules/.bin"), { recursive: true });
      const cyclicBin = path.join(sandbox, "node_modules/.bin/tsx");
      await fs.symlink(cyclicBin, cyclicBin);

      const sandboxSupervisor = spawn(process.execPath, [
        path.join(sandbox, "scripts/dev-api.mjs"),
        "--",
        cyclicBin,
      ], { cwd: sandbox, env: { ...process.env, DEV_API_DEBOUNCE_MS: "100", DEV_API_RESTART_MS: "100" }, stdio: ["ignore", "pipe", "pipe"] });
      supervisor = sandboxSupervisor;
      const localLog: string[] = [];
      sandboxSupervisor.stdout!.on("data", (c) => localLog.push(c.toString()));
      sandboxSupervisor.stderr!.on("data", (c) => localLog.push(c.toString()));

      // Let it churn for ~5s. With RESTART_DELAY_MS=100 and no cooldown, it
      // would have run `npm install` ~50 times. With the 30s cooldown, it
      // runs at most twice (start + maybe one after cooldown).
      await new Promise((r) => setTimeout(r, 5_000));
      const out = localLog.join("");
      const installs = (out.match(/running .*npm install/g) ?? []).length;
      const cooldownSkips = (out.match(/heal cooldown active/g) ?? []).length;
      expect(installs, "npm install should be cooldown-limited").toBeLessThanOrEqual(1);
      expect(cooldownSkips, "subsequent ELOOPs in the window should log a cooldown skip").toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it("circuit-breaker: exits non-zero after MAX failed spawns with no successful boot (prevents 2026-05-23-style orphan CPU bombs)", async () => {
    // Regression for the 2026-05-23 outage: a chaos-test sandbox's
    // dev-api.mjs was orphaned (PPID=1) and sat in a respawn loop for
    // 2h18m at 99% CPU because nothing ever told it to stop.
    //
    // Contract: if we've NEVER successfully booted a child (i.e. nothing
    // has survived STARTUP_GRACE_MS), give up after
    // MAX_FAILED_SPAWNS_BEFORE_GIVE_UP and exit 75 (EX_TEMPFAIL).
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dev-api-circuit-breaker-"));
    try {
      // Point at a binary that doesn't exist — spawn() throws ENOENT
      // synchronously every time.
      const sup = spawn(process.execPath, [scriptPath, "--", path.join(sandbox, "definitely-not-a-binary")], {
        cwd: sandbox,
        env: {
          ...process.env,
          DEV_API_RESTART_MS: "20",
          DEV_API_MAX_FAILED_SPAWNS_BEFORE_GIVE_UP: "5",
          DEV_API_STARTUP_GRACE_MS: "500",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      supervisor = sup;
      const localLog: string[] = [];
      sup.stdout!.on("data", (c) => localLog.push(c.toString()));
      sup.stderr!.on("data", (c) => localLog.push(c.toString()));

      const exit = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
          sup.once("exit", (code, signal) => resolve({ code, signal })),
        ),
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_, reject) =>
          setTimeout(() => reject(new Error(`circuit breaker didn't fire within 5s. log:\n${localLog.join("")}`)), 5_000),
        ),
      ]);

      expect(exit.code, "circuit-breaker should exit non-zero (EX_TEMPFAIL=75)").toBe(75);
      expect(localLog.join(""), "should log the give-up reason").toMatch(/giving up: \d+ consecutive failed spawns/);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }, 10_000);

  it("circuit-breaker: stays armed across N failures but DISARMS after one successful boot (production must respawn forever)", async () => {
    // The breaker MUST NOT trip in the documented production failure mode:
    // a long-running supervisor whose child crashes occasionally (git pull,
    // file edit, transient EADDRINUSE). Once we've ever had a child live
    // past STARTUP_GRACE_MS, the breaker is permanently disarmed.
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dev-api-circuit-disarm-"));
    try {
      // Child that immediately exits 0 (instant crash). With STARTUP_GRACE_MS=200
      // and 100ms restart, we'd fire the breaker if it were armed forever.
      // But our wrapper script will sleep > grace before exiting once, then
      // exit immediately on subsequent runs. We achieve this via a tiny
      // counter file inside the sandbox.
      const wrapper = path.join(sandbox, "once-long-then-instant.sh");
      await fs.writeFile(wrapper,
        `#!/bin/bash\nf="${sandbox}/.runs"; n=$(cat "$f" 2>/dev/null || echo 0)\n` +
        `echo $((n+1)) > "$f"\nif [ "$n" = "0" ]; then sleep 0.6; exit 0; else exit 1; fi\n`,
      );
      await fs.chmod(wrapper, 0o755);

      const sup = spawn(process.execPath, [scriptPath, "--", wrapper], {
        cwd: sandbox,
        env: {
          ...process.env,
          DEV_API_RESTART_MS: "30",
          DEV_API_MAX_FAILED_SPAWNS_BEFORE_GIVE_UP: "5",
          DEV_API_STARTUP_GRACE_MS: "300",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      supervisor = sup;
      const localLog: string[] = [];
      sup.stdout!.on("data", (c) => localLog.push(c.toString()));
      sup.stderr!.on("data", (c) => localLog.push(c.toString()));

      // Let it run long enough that the FIRST run (sleep 0.6) crosses the
      // 300ms grace window AND we'd otherwise hit the 5-failure threshold
      // from the subsequent insta-exit children. 4s is comfortably both.
      await new Promise((r) => setTimeout(r, 4_000));

      // Supervisor must still be alive (NOT tripped) because the first child
      // disarmed the breaker by living past STARTUP_GRACE_MS.
      expect(sup.exitCode, `breaker should not have tripped after a successful boot. log:\n${localLog.join("")}`)
        .toBe(null);
      // And we should be on something like >5 spawns by now (proving the
      // child has been restarted many times since the first success).
      const spawns = (localLog.join("").match(/spawned pid=/g) ?? []).length;
      expect(spawns, "should have respawned many times post-success").toBeGreaterThan(5);
      expect(localLog.join(""), "giving up message must NOT appear once we've ever booted")
        .not.toMatch(/giving up:/);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }, 10_000);
});
