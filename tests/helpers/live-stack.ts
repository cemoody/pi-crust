/**
 * LiveStack — the reproducible "whole deployment in a sandbox" orchestrator.
 *
 * One `startLiveStack()` call stands up the entire live topology the way
 * run-live.sh does in production, but hermetically in temp dirs:
 *
 *   • a real bare git remote + working clone        (the "repo")
 *   • a dedicated config dir with clean extensions  (the .pi-crust-live isolation)
 *   • a dedicated runtime dir (XDG_RUNTIME_DIR)      (sandboxed /tmp sockets)
 *   • a fake-pi binary                               (deterministic worker, no LLM)
 *   • the REAL dev-api.mjs loop on a random port     (production-shape supervisor)
 *   • optionally the REAL dev-git-puller.mjs         (against the fake remote)
 *
 * and returns a handle that lets a scenario test perturb it (push commits,
 * break the build, kill workers, squat the port) and assert on the emergent,
 * unix-level behavior (port ownership, orphans, stale sockets, session health).
 *
 * Design notes
 * ------------
 *  - We launch the *real* server via `npm run dev:api` under dev-api.mjs so the
 *    npm→tsx→server signal chain and the detached-supervisor lifecycle are
 *    exercised, not mocked. fake-pi is injected via PI_CRUST_PI_COMMAND (a thin
 *    seam added to resolvePiCommand()).
 *  - Everything is keyed off a single random base port and per-stack tmp dirs,
 *    so stacks are parallel-safe (we still run scenarios sequentially for calm).
 *  - teardown() reaps the full process tree (loop + detached supervisors + fake
 *    workers + puller) and removes every sandbox dir. The process-hygiene guard
 *    is the backstop; teardown() is the contract.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFakePi, type FakePi } from "./fake-pi.js";
import {
  descendantsOf,
  isAlive,
  killTree,
  tcpListenersOnPort,
  waitFor,
  waitForPortFree,
} from "./process-tree.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const DEV_API = path.join(REPO_ROOT, "scripts", "dev-api.mjs");
const GIT_PULLER = path.join(REPO_ROOT, "scripts", "dev-git-puller.mjs");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Scenario",
  GIT_AUTHOR_EMAIL: "scenario@example.com",
  GIT_COMMITTER_NAME: "Scenario",
  GIT_COMMITTER_EMAIL: "scenario@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Reserve an ephemeral TCP port by binding then releasing it. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") { srv.close(); reject(new Error("no port")); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

export interface StartLiveStackOptions {
  /**
   * Build a REAL working checkout (a clone of the repo with package.json +
   * node_modules symlinked to the hub) so `npm run dev:api` runs the checkout's
   * own code and the live /api/health gitSha tracks the checkout's HEAD. Needed
   * by rollout scenarios. Heavier (~5s clone). Default false (lightweight
   * minimal checkout; the server runs REPO_ROOT's code).
   */
  realCheckout?: boolean;
  /** Run the git-puller against the fake remote. Default false. */
  withPuller?: boolean;
  /** Enable the auto-rollout pipeline (Feature A). Default false. */
  autoRollout?: boolean;
  /** Reuse a specific base port (for the port-squatter scenario). */
  port?: number;
  /** Expect the server to REFUSE to start (single-owner test). Default false. */
  expectRefusal?: boolean;
  /** Extra env passed to the dev-api loop. */
  env?: Record<string, string>;
  /** Label for logs / sandbox prefix. */
  label?: string;
}

interface HealthResponse {
  ok: boolean;
  gitSha?: string;
  sessions?: { total: number; healthy: number; broken: number };
  [k: string]: unknown;
}

export interface LiveStack {
  readonly port: number;
  readonly baseUrl: string;
  /** The working clone the server runs from. */
  readonly checkout: string;
  /** The bare git remote (origin). */
  readonly remoteRepo: string;
  /** Dedicated runtime dir (XDG_RUNTIME_DIR/pi-crust). */
  readonly runtimeDir: string;
  /** Dedicated config dir. */
  readonly configDir: string;

  /** Raw combined stdout+stderr of the dev-api loop so far. */
  log(): string;
  /** Raw combined log of the git-puller (if started). */
  pullerLog(): string;

  api: {
    health(): Promise<HealthResponse>;
    listSessions(): Promise<Array<{ id: string; [k: string]: unknown }>>;
    /** Open/get a session's state. Returns {status, body}. */
    openSession(id: string): Promise<{ status: number; body: unknown }>;
    /** Create a new live session rooted at the checkout. Returns its id. */
    createSession(): Promise<string>;
  };

  remote: {
    /** Commit `files` on origin/main and advance the remote head. Returns new sha. */
    pushCommit(files: Record<string, string>, message?: string): Promise<string>;
    /** Push a commit that breaks the build/boot in a named way (rollout-block test). */
    pushBreaking(kind: "dup-extension" | "syntax-error"): Promise<string>;
    /** Current origin/main short sha. */
    headSha(): string;
  };

  proc: {
    /** Pid of the dev-api loop supervisor. */
    loopPid(): number;
    /** Pid(s) of the http server child (the port holder). */
    apiChildPids(): Promise<number[]>;
    /** Pid(s) of detached pirpc-supervisor workers. */
    workerPids(): Promise<number[]>;
    /** SIGKILL the http server child (simulate API crash; loop should respawn). */
    killApiChild(): Promise<void>;
    /** SIGKILL the worker(s) for a session (simulate worker death + socket loss). */
    killWorker(sessionId?: string): Promise<void>;
  };

  /** Spawn an unrelated process that grabs the stack's port. */
  squatPort(): Promise<void>;

  /** Wait until the API answers /api/health 200. */
  waitForApi(timeoutMs?: number): Promise<void>;
  /** Wait until a rollout completes (health gitSha changes from `fromSha`). */
  waitForRollout(fromSha: string, timeoutMs?: number): Promise<void>;

  assert: {
    sessionsHealthy(): Promise<void>;
    noOrphans(): Promise<void>;
    noStaleSockets(): Promise<void>;
    portOwnedByUs(): Promise<void>;
  };

  teardown(): Promise<void>;
}

export async function startLiveStack(opts: StartLiveStackOptions = {}): Promise<LiveStack> {
  const label = opts.label ?? "stack";
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `pi-crust-scenario-${label}-`));
  const remoteRepo = path.join(sandbox, "origin.git");
  const seed = path.join(sandbox, "seed");
  const checkout = path.join(sandbox, "checkout");
  const configDir = path.join(sandbox, "config");
  const xdgDir = path.join(sandbox, "xdg");
  const runtimeDir = path.join(xdgDir, "pi-crust");
  const sessionRoot = path.join(sandbox, "sessions");
  const port = opts.port ?? (await pickFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;

  // --- 1. fake git remote + seed + working clone ---------------------------
  const realCheckout = opts.realCheckout ?? false;
  if (realCheckout) {
    // Bare remote = clone of the actual repo; checkout = real working copy.
    // Pushes to the bare remote's main are ff-pulled into the checkout by the
    // puller, advancing the checkout's HEAD (and thus /api/health gitSha).
    spawnSync("git", ["clone", "--bare", "--no-hardlinks", `file://${REPO_ROOT}`, remoteRepo],
      { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    // A `seed` working clone we use to author synthetic commits + push them.
    spawnSync("git", ["clone", remoteRepo, seed], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    git(seed, "checkout", "main");
    // The live checkout the server runs from.
    spawnSync("git", ["clone", remoteRepo, checkout], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    git(checkout, "checkout", "main");
    // Share the dependency hub so `npm run dev:api` resolves tsx + deps.
    await fs.symlink(path.join(REPO_ROOT, "node_modules"), path.join(checkout, "node_modules"));
  } else {
    await fs.mkdir(remoteRepo, { recursive: true });
    git(remoteRepo, "init", "--bare", "--initial-branch", "main");
    await fs.mkdir(seed, { recursive: true });
    git(seed, "init", "--initial-branch", "main");
    git(seed, "remote", "add", "origin", remoteRepo);
    // Minimal checkout: just a cwd + .git for the puller. The server runs
    // REPO_ROOT's code via the absolute dev-api.mjs path.
    await fs.writeFile(path.join(seed, "README.md"), "scenario seed\n");
    await fs.writeFile(path.join(seed, "VERSION"), "v0\n");
    git(seed, "add", "."); git(seed, "commit", "-m", "seed"); git(seed, "push", "origin", "main");
    spawnSync("git", ["clone", remoteRepo, checkout], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  }

  // --- 2. dedicated config dir (clean extensions => no conflict) -----------
  await fs.mkdir(path.join(configDir, "extensions"), { recursive: true });
  await fs.writeFile(path.join(configDir, "settings.json"), "{}\n");

  // --- 3. dedicated runtime dir --------------------------------------------
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });

  // --- 4. fake-pi binary ----------------------------------------------------
  const fakePi: FakePi = await makeFakePi({ sessionId: `${label}-fp`, initialEvents: 0 });

  // --- 5. spawn the REAL dev-api loop --------------------------------------
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PI_CRUST_API_HOST: "127.0.0.1",
    PI_CRUST_API_PORT: String(port),
    PI_CRUST_CONFIG_DIR: configDir,
    PI_CRUST_SESSION_ROOT: sessionRoot,
    PI_CRUST_PROJECT_ROOT: checkout,
    PI_CRUST_PI_COMMAND: fakePi.executable,
    XDG_RUNTIME_DIR: xdgDir,
    DEV_API_PORT_HINT: String(port),
    DEV_API_DEBOUNCE_MS: "150",
    DEV_API_RESTART_MS: "200",
    DEV_API_STARTUP_GRACE_MS: "1500",
    ...(opts.autoRollout ? { PI_CRUST_AUTO_ROLLOUT: "1" } : {}),
    ...opts.env,
  };

  // In realCheckout mode run the checkout's OWN dev-api.mjs so process.cwd() is
  // the checkout and the live gitSha tracks its HEAD. Otherwise run REPO_ROOT's
  // script (lightweight; gitSha not asserted by those scenarios).
  const devApiScript = realCheckout ? path.join(checkout, "scripts", "dev-api.mjs") : DEV_API;
  const chunks: string[] = [];
  const loop = spawn(process.execPath, [devApiScript, "--", "npm", "run", "dev:api"], {
    cwd: checkout,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  loop.stdout?.on("data", (c) => chunks.push(c.toString()));
  loop.stderr?.on("data", (c) => chunks.push(c.toString()));
  const logFn = () => chunks.join("");

  // --- 6. optional git-puller ----------------------------------------------
  const pullerChunks: string[] = [];
  let puller: ChildProcess | undefined;
  if (opts.withPuller) {
    puller = spawn(process.execPath, [GIT_PULLER], {
      cwd: checkout,
      env: { ...env, DEV_GIT_PULL_INTERVAL_S: "0.3", DEV_GIT_PULL_BRANCH: "main" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    puller.stdout?.on("data", (c) => pullerChunks.push(c.toString()));
    puller.stderr?.on("data", (c) => pullerChunks.push(c.toString()));
  }

  // ---- helpers bound to this stack ----------------------------------------
  const httpJson = async (method: string, p: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${p}`, init);
    let parsed: unknown = undefined;
    const text = await res.text();
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  };

  const health = async (): Promise<HealthResponse> => {
    const r = await httpJson("GET", "/api/health");
    if (r.status !== 200) throw new Error(`health -> ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body as HealthResponse;
  };

  const apiChildPids = async (): Promise<number[]> => {
    if (!loop.pid) return [];
    // The http server child is the port holder; return the loop's descendants
    // that currently hold the port (npm/tsx/server chain collapses to these).
    const kids = new Set(await descendantsOf(loop.pid, false));
    return (await tcpListenersOnPort(port)).filter((p) => kids.has(p));
  };

  const workerPids = async (): Promise<number[]> => {
    // pirpc-supervisor workers are detached (ppid=1), so descendantsOf won't
    // find them. Match by argv + this stack's runtime dir.
    const out: number[] = [];
    let entries: string[] = [];
    try { entries = await fs.readdir("/proc"); } catch { return out; }
    await Promise.all(entries.map(async (e) => {
      if (!/^\d+$/.test(e)) return;
      let cmd = "";
      try { cmd = (await fs.readFile(`/proc/${e}/cmdline`, "utf8")).split("\0").join(" "); } catch { return; }
      if (cmd.includes("pirpc-supervisor.mjs") && cmd.includes(runtimeDir)) out.push(Number(e));
    }));
    return out;
  };

  const socketsDir = path.join(runtimeDir, "s");
  const squatters: ChildProcess[] = [];

  const stack: LiveStack = {
    port, baseUrl, checkout, remoteRepo, runtimeDir, configDir,
    log: logFn,
    pullerLog: () => pullerChunks.join(""),

    api: {
      health,
      listSessions: async () => {
        const r = await httpJson("GET", "/api/sessions");
        const b = r.body as { sessions?: Array<{ id: string }> } | Array<{ id: string }>;
        return Array.isArray(b) ? b : (b.sessions ?? []);
      },
      openSession: async (id: string) => httpJson("GET", `/api/sessions/${id}/state`),
      createSession: async () => {
        const r = await httpJson("POST", "/api/sessions", { cwd: checkout });
        if (r.status >= 300) throw new Error(`createSession -> ${r.status}: ${JSON.stringify(r.body)}`);
        return (r.body as { id: string }).id;
      },
    },

    remote: {
      pushCommit: async (files, message = "scenario commit") => {
        for (const [rel, content] of Object.entries(files)) {
          const abs = path.join(seed, rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content);
        }
        git(seed, "add", ".");
        git(seed, "commit", "-m", message);
        git(seed, "push", "origin", "main");
        return git(seed, "rev-parse", "--short", "HEAD");
      },
      pushBreaking: async (kind) => {
        if (kind === "dup-extension") {
          // Recreate today's incident shape: a discovered extension that
          // re-registers a tool the bundled package already owns.
          await fs.writeFile(path.join(seed, "BREAK_DUP_EXTENSION"),
            "duplicate show_pr_story tool registration\n");
        } else {
          await fs.writeFile(path.join(seed, "src-broken.mjs"), "this is ((( not valid js\n");
        }
        git(seed, "add", ".");
        git(seed, "commit", "-m", `breaking: ${kind}`);
        git(seed, "push", "origin", "main");
        return git(seed, "rev-parse", "--short", "HEAD");
      },
      headSha: () => git(seed, "rev-parse", "--short", "HEAD"),
    },

    proc: {
      loopPid: () => loop.pid ?? -1,
      apiChildPids,
      workerPids,
      killApiChild: async () => {
        const holders = await tcpListenersOnPort(port);
        for (const pid of holders) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      },
      killWorker: async () => {
        for (const pid of await workerPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      },
    },

    squatPort: async () => {
      const script = `import http from "node:http";` +
        `const s=http.createServer((_,r)=>{r.writeHead(200);r.end("squatter")});` +
        `s.listen(${port},"127.0.0.1",()=>process.stdout.write("ready\\n"));`;
      const sq = spawn(process.execPath, ["--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "pipe"], detached: false });
      squatters.push(sq);
      await new Promise<void>((resolve, reject) => {
        sq.stdout?.on("data", (c) => { if (c.toString().includes("ready")) resolve(); });
        sq.once("exit", () => reject(new Error("squatter exited before ready")));
        setTimeout(() => reject(new Error("squatter not ready in 3s")), 3000);
      });
    },

    waitForApi: async (timeoutMs = 20_000) => {
      await waitFor(async () => {
        try { return (await health()).ok === true; } catch { return false; }
      }, { timeoutMs, label: "api health 200", pollMs: 150 });
    },

    waitForRollout: async (fromSha, timeoutMs = 30_000) => {
      await waitFor(async () => {
        try { const h = await health(); return !!h.gitSha && h.gitSha !== fromSha; }
        catch { return false; }
      }, { timeoutMs, label: `rollout away from ${fromSha}`, pollMs: 250 });
    },

    assert: {
      sessionsHealthy: async () => {
        const h = await health();
        const s = h.sessions;
        if (!s) throw new Error("health missing sessions summary");
        if (s.broken !== 0) throw new Error(`expected 0 broken sessions, got ${s.broken}`);
      },
      noOrphans: async () => {
        // No pirpc-supervisor for this runtime dir should outlive teardown;
        // mid-test we just assert none are zombies/defunct.
        const pids = await workerPids();
        for (const pid of pids) {
          if (!isAlive(pid)) throw new Error(`worker ${pid} is a zombie`);
        }
      },
      noStaleSockets: async () => {
        // Every .sock in the runtime dir must have a live owner OR a matching
        // session-meta json. A stale socket with no owner is the ENOENT bug.
        let socks: string[] = [];
        try { socks = (await fs.readdir(socketsDir)).filter((f) => f.endsWith(".sock")); } catch { return; }
        const live = new Set<string>();
        // crude liveness: ss -xlp listing includes the path of live UDS.
        const ss = spawnSync("ss", ["-xlpnH"], { encoding: "utf8" });
        for (const f of socks) if (ss.stdout?.includes(path.join(socketsDir, f))) live.add(f);
        const stale = socks.filter((f) => !live.has(f));
        if (stale.length) throw new Error(`stale sockets with no listener: ${stale.join(", ")}`);
      },
      portOwnedByUs: async () => {
        const holders = await tcpListenersOnPort(port);
        if (holders.length === 0) throw new Error(`port ${port} has no listener`);
        if (!loop.pid) throw new Error("loop has no pid");
        const ours = await descendantsOf(loop.pid, false);
        const ownSet = new Set(ours);
        if (!holders.some((p) => ownSet.has(p))) {
          throw new Error(`port ${port} held by ${holders.join(",")} — none are our descendants`);
        }
      },
    },

    teardown: async () => {
      if (puller && !puller.killed) { puller.kill("SIGTERM"); }
      for (const sq of squatters) { try { sq.kill("SIGKILL"); } catch { /* */ } }
      // SIGTERM the loop so it detaches workers cleanly, then reap the tree.
      if (loop.pid && isAlive(loop.pid)) {
        loop.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000);
          loop.once("exit", () => { clearTimeout(t); resolve(); });
        });
        try { await killTree(loop.pid, true); } catch { /* */ }
      }
      // Kill any detached workers for this runtime dir.
      for (const pid of await workerPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* */ } }
      await waitForPortFree(port, 5000).catch(() => {});
      await fakePi.cleanup().catch(() => {});
      await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
    },
  };

  // For refusal scenarios the caller expects the loop NOT to come up healthy.
  if (!opts.expectRefusal) {
    await stack.waitForApi();
  }
  return stack;
}
