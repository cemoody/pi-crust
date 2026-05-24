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
 * Single-process launcher for pi-crust.
 *
 * Boots the HTTP+SSE API and (when dist/ is present) has it serve the built
 * Vite pi-crust from the same port. Designed to be invoked via:
 *
 *   npx -y -p github:cemoody/pi-crust pi-crust
 *
 * On install (`npm install` after npx clones), the `prepare` script runs
 * `vite build` and produces dist/. This launcher then points the API at it
 * via PI_CRUST_UI_DIR so a single Node process hosts everything.
 *
 * Env knobs:
 *   PI_CRUST_API_PORT   port to bind (default 8787)
 *   PI_CRUST_API_HOST   bind host (default 127.0.0.1, override to 0.0.0.0
 *                        when sharing on a tailnet)
 *   PI_CRUST_OPEN       set to "0" to skip opening the system browser
 *   PI_CRUST_APP_NAME   app title shown in the pi-crust (default "π crust")
 *   PI_CRUST_APP_ICON   app title icon: emoji/text glyph, image URL/path, or data URL
 *   PI_CRUST_ADAPTER    "pirpc" (default) / "pi-sdk" / "mock"
 *   PI_CRUST_USE_MOCK   set to "1" for the offline mock adapter
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const distDir = path.join(repoRoot, "dist");
const apiEntry = path.join(repoRoot, "src/server/http-api-server.ts");
const packageCommandEntry = path.join(repoRoot, "src/cli/package-command.ts");

const port = process.env.PI_CRUST_API_PORT ?? "8787";
const host = process.env.PI_CRUST_API_HOST ?? "127.0.0.1";

// Resolve tsx via Node's module resolution so it works whether tsx lives in
// repoRoot/node_modules (local dev) or hoisted to a sibling node_modules
// (typical npx-from-tarball / github layout).
const requireFromHere = createRequire(import.meta.url);
let tsxCli;
const tsxCandidates = [
  // 1. Standard Node module resolution from this file's location.
  () => requireFromHere.resolve("tsx/dist/cli.mjs"),
  // 2. Local dev: repoRoot/node_modules/tsx (also covered by #1, kept for safety).
  () => {
    const p = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
    if (existsSync(p)) return p;
    throw new Error("not at " + p);
  },
  // 3. npx layout: sibling node_modules (one level up from our package).
  () => {
    const p = path.resolve(repoRoot, "..", "tsx/dist/cli.mjs");
    if (existsSync(p)) return p;
    throw new Error("not at " + p);
  },
];
let lastErr;
for (const lookup of tsxCandidates) {
  try { tsxCli = lookup(); break; } catch (e) { lastErr = e; }
}
if (!tsxCli) {
  console.error("[pi-crust] tsx is not installed. Did `npm install` succeed?");
  console.error("  repoRoot         = " + repoRoot);
  console.error("  import.meta.url  = " + import.meta.url);
  console.error("  last resolve err = " + (lastErr && lastErr.message));
  process.exit(1);
}
if (!existsSync(apiEntry)) {
  console.error(`[pi-crust] API entry missing: ${apiEntry}`);
  process.exit(1);
}

const [subcommand, ...subcommandArgs] = process.argv.slice(2);
if (subcommand === "install" || subcommand === "remove" || subcommand === "uninstall") {
  if (!existsSync(packageCommandEntry)) {
    console.error(`[pi-crust] package command entry missing: ${packageCommandEntry}`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [tsxCli, packageCommandEntry, subcommand, ...subcommandArgs], { env: process.env, stdio: "inherit", cwd: process.cwd() });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
if (!existsSync(distDir)) {
  console.warn("[pi-crust] dist/ not found — falling back to API-only mode.");
  console.warn("  Run `npm run build` to produce the pi-crust, then re-run.");
}

const env = {
  ...process.env,
  PI_CRUST_API_PORT: port,
  PI_CRUST_API_HOST: host,
  ...(existsSync(distDir) ? { PI_CRUST_UI_DIR: distDir } : {}),
};

const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/`;

console.log("");
console.log("  pi-crust");
console.log("  ─────────────────");
console.log(`  pi-crust + API  →  ${url}`);
console.log(`  bind       →  ${host}:${port}`);
console.log(`  adapter    →  ${env.PI_CRUST_ADAPTER ?? (env.PI_CRUST_USE_MOCK === "1" ? "mock" : "pirpc")}`);
console.log("");
console.log("  Tailscale tip: re-run with PI_CRUST_API_HOST=0.0.0.0");
console.log("  Stop: Ctrl-C");
console.log("");

const child = spawn(process.execPath, [tsxCli, apiEntry], { env, stdio: "inherit", cwd: repoRoot });

// Best-effort: open the system browser once the server is up.
if (process.env.PI_CRUST_OPEN !== "0") {
  const probe = async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          const opener = os.platform() === "darwin" ? "open"
                      : os.platform() === "win32" ? "start"
                      : "xdg-open";
          spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  probe().catch(() => {});
}

const forward = (sig) => { try { child.kill(sig); } catch {} };
process.on("SIGINT",  () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
}
