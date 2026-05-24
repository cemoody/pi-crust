#!/usr/bin/env node
// --- PI_REMOTE_* → PI_CRUST_* env-var compat shim (must run BEFORE any env reads).
// Removable after one deprecation release.
(() => {
  const pairs = [["PI_REMOTE_", "PI_CRUST_"], ["VITE_PI_REMOTE_", "VITE_PI_CRUST_"]];
  const mirrored = [];
  for (const k of Object.keys(process.env)) {
    for (const [op, np] of pairs) {
      if (!k.startsWith(op)) continue;
      const nk = np + k.slice(op.length);
      if (process.env[nk] !== undefined) break;
      process.env[nk] = process.env[k];
      mirrored.push(k);
      break;
    }
  }
  if (mirrored.length > 0 && process.env.PI_CRUST_SUPPRESS_RENAME_WARNING !== "1") {
    process.stderr.write(`[pi-crust] deprecated env vars detected; mirroring to new names: ${mirrored.join(", ")}
`);
    process.stderr.write(`[pi-crust] update your config to PI_CRUST_*. Set PI_CRUST_SUPPRESS_RENAME_WARNING=1 to silence.
`);
  }
})();

/**
 * Dev-mode launcher for pi-crust over npx.
 *
 *   npx -y -p github:cemoody/pi-crust pi-crust-dev
 *
 * Single Node process that orchestrates the same self-edit dev loop a
 * `git clone`'d developer gets, without requiring a clone:
 *
 *   - Vite on PI_CRUST_WEB_PORT (default 5173), HMR enabled, proxies
 *     /api/* to the api on PI_CRUST_API_PORT.
 *   - api server under scripts/dev-api.mjs, which watches src/server/**
 *     and SIGTERMs+respawns the api process on every edit (active chat
 *     sessions survive via the detach/reattach machinery already in
 *     http-api-server.ts).
 *
 * Output from both is piped to stdout with a colored prefix; signals
 * propagate atomically to both via process-group kills.
 *
 * Auto-pull from origin/main is OFF by default. The npx install lives
 * under ~/.npm/_npx/<hash>/ and gets wiped on the next npx invocation
 * anyway, and most callers won't be on github auth from the launcher's
 * env. Set PI_CRUST_DEV_GIT_PULL=1 to opt in (it spawns
 * scripts/dev-git-puller.mjs).
 *
 * Env knobs:
 *   PI_CRUST_API_PORT    api port (default 8787)
 *   PI_CRUST_WEB_PORT    vite port (default 5173)
 *   PI_CRUST_DEV_HOST    bind host for both vite and api (default 0.0.0.0)
 *   PI_CRUST_DEV_GIT_PULL=1   also run the auto-pull loop
 *   PI_CRUST_OPEN=0      skip opening the system browser
 *   PI_CRUST_USE_MOCK=1  offline mock adapter (no `pi` binary needed)
 *   PI_CRUST_ADAPTER     pirpc (default) / pi-sdk / mock
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const VITE_PORT = String(process.env.PI_CRUST_WEB_PORT ?? "5173");
const API_PORT = String(process.env.PI_CRUST_API_PORT ?? "8787");
const HOST = process.env.PI_CRUST_DEV_HOST ?? "0.0.0.0";
const ENABLE_PULLER = process.env.PI_CRUST_DEV_GIT_PULL === "1";

// Resolve the deps we're about to spawn. devDeps DO get installed when
// npm install --include=dev is implied by a github: spec running
// `prepare` (which runs `vite build`), so under the npx-from-github
// install path these paths are present. Fail clearly otherwise.
const VITE_CLI = path.join(repoRoot, "node_modules/vite/bin/vite.js");
const TSX_CLI = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const API_ENTRY = path.join(repoRoot, "src/server/http-api-server.ts");
const DEV_API_SCRIPT = path.join(repoRoot, "scripts/dev-api.mjs");
const PULLER_SCRIPT = path.join(repoRoot, "scripts/dev-git-puller.mjs");

function fail(msg) {
  process.stderr.write(`pi-crust-dev: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(VITE_CLI)) fail(`vite not found at ${VITE_CLI}. Re-run with devDependencies installed (npm install --include=dev or the github: npx spec, not a plain tarball install).`);
if (!existsSync(TSX_CLI)) fail(`tsx not found at ${TSX_CLI}. Try \`npm install\` in this directory.`);
if (!existsSync(API_ENTRY)) fail(`api entry not found at ${API_ENTRY}. This launcher is for the dev/clone install, not the prod npx \`pi-crust\` launcher.`);
if (!existsSync(DEV_API_SCRIPT)) fail(`dev-api supervisor not found at ${DEV_API_SCRIPT}. Make sure scripts/ ships in the package.json \`files\`.`);

// --- child plumbing --------------------------------------------------

const children = [];
let shuttingDown = false;

const COLORS = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", magenta: "\x1b[35m", red: "\x1b[31m", dim: "\x1b[2m" };

function spawnTagged({ name, color, command, args, env = {} }) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group: lets us atomically signal grandchildren too
  });
  const prefix = `${color}[${name}]${COLORS.reset} `;
  const pipe = (stream, isStderr) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const out = isStderr ? process.stderr : process.stdout;
        out.write(prefix + line + "\n");
      }
    });
    stream.on("end", () => { if (buf) process.stdout.write(prefix + buf + "\n"); });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(prefix + `${COLORS.dim}(exited code=${code} signal=${signal} — tearing down siblings)${COLORS.reset}\n`);
    shutdown();
  });
  child.on("error", (err) => {
    process.stderr.write(prefix + `${COLORS.red}spawn error: ${err.message}${COLORS.reset}\n`);
  });
  children.push({ name, child });
  return child;
}

function killGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (err) { if (err && err.code !== "ESRCH") process.stderr.write(`kill ${signal} pgid=${pid}: ${err.message}\n`); }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.pid) killGroup(child.pid, "SIGTERM");
  }
  // Escalate any that didn't go down.
  setTimeout(() => {
    for (const { child } of children) {
      if (child.pid && !child.killed) killGroup(child.pid, "SIGKILL");
    }
    process.exit(0);
  }, 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- spawn the children ---------------------------------------------

spawnTagged({
  name: "vite",
  color: COLORS.cyan,
  command: process.execPath,
  args: [VITE_CLI, "--host", HOST, "--port", VITE_PORT],
  env: {
    // Vite needs to know where the api lives so its /api proxy works.
    VITE_PI_CRUST_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
  },
});

spawnTagged({
  name: " api",
  color: COLORS.green,
  command: process.execPath,
  args: [DEV_API_SCRIPT, "--", process.execPath, TSX_CLI, API_ENTRY],
  env: {
    PI_CRUST_API_PORT: API_PORT,
    PI_CRUST_API_HOST: HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
  },
});

if (ENABLE_PULLER) {
  spawnTagged({
    name: " git",
    color: COLORS.magenta,
    command: process.execPath,
    args: [PULLER_SCRIPT],
  });
}

// --- summary banner --------------------------------------------------

const visibleHost = HOST === "0.0.0.0" ? "localhost" : HOST;
process.stdout.write(`
${COLORS.cyan}pi-crust-dev${COLORS.reset}
  pi-crust:   http://${visibleHost}:${VITE_PORT}/
  api:   http://${visibleHost}:${API_PORT}/api/health
  edit:  src/web/** → Vite HMR;  src/server/** → api restart
  pull:  ${ENABLE_PULLER ? "ON (PI_CRUST_DEV_GIT_PULL=1)" : "OFF (set PI_CRUST_DEV_GIT_PULL=1 to enable)"}
  stop:  Ctrl-C

`);
