import path from "node:path";
import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_PI_REMOTE_PROXY_TARGET ?? "http://127.0.0.1:8787";

// Resolve the frontend's git SHA at vite-config evaluation time. The result
// gets baked into the bundle via `define` below as __PI_REMOTE_GIT_SHA__
// and surfaced in the help dialog. CI / Docker builds can pass
// PI_REMOTE_GIT_SHA explicitly; the local dev case shells out to git.
function resolveFrontendGitSha(): string {
  const fromEnv = process.env.PI_REMOTE_GIT_SHA;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim().slice(0, 12);
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 })
      .toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}
const frontendGitSha = resolveFrontendGitSha();

// HMR is ON by default to support the self-edit workflow: agent or human
// edits a source file and the browser updates in place without a full
// reload. The reload-on-disconnect behavior that historically wrecked
// iPhone Safari scroll position is now tamed client-side in
// src/web/utils/hmr-tame.ts (cancels Vite's auto-reload when the tab is
// hidden or has just resumed from background). Set VITE_PI_REMOTE_HMR=0
// to force HMR off if you ever need the old behavior.
const hmrEnabled = process.env.VITE_PI_REMOTE_HMR !== "0";

// Vite (≥6.0) rejects requests whose Host header isn't in `allowedHosts`
// when bound to a non-localhost interface. The default list is just
// localhost/127.0.0.1, which blocks legitimate access via Tailscale magic
// DNS (`<machine>.<tailnet>.ts.net`) and mDNS (`*.local`) — both common
// for accessing the WUI from another device on the same network.
//
// We allow those two suffixes by default (a leading dot in Vite's syntax
// matches the host AND any subdomain), and let users extend or replace the
// list via VITE_PI_REMOTE_ALLOWED_HOSTS (comma-separated). Setting it to
// the literal string `all` disables the check entirely — use only on
// trusted networks.
const DEFAULT_ALLOWED_HOSTS = [".ts.net", ".local"] as const;
const rawAllowed = process.env.VITE_PI_REMOTE_ALLOWED_HOSTS;
const allowedHosts: true | string[] = rawAllowed === "all"
  ? true
  : rawAllowed
    ? rawAllowed.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_ALLOWED_HOSTS];

/**
 * Vite reads its own config exactly once at startup and never reloads it.
 * For the self-edit workflow we want edits to vite.config.ts to take effect
 * just like edits to any other file. Strategy: watch the config file from
 * within Vite, and on change exit the Vite process. The outer restart loop
 * (scripts/dev-loop.sh via npm run dev:web:loop) brings it back with the
 * new config in <1s.
 */
function restartOnConfigChange(): Plugin {
  const configFile = path.resolve(__dirname, "vite.config.ts");
  return {
    name: "pi-remote-restart-on-config-change",
    configureServer(server) {
      server.watcher.add(configFile);
      server.watcher.on("change", (file) => {
        if (path.resolve(file) !== configFile) return;
        server.config.logger.info(
          "\n[restart-on-config-change] vite.config.ts changed — exiting so the outer restart loop can pick up the new config.\n",
          { timestamp: true },
        );
        // Tiny delay so the log line flushes before the process exits.
        setTimeout(() => process.exit(0), 50).unref();
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), restartOnConfigChange()],
  // Bake the SHA into the bundle ONLY for production builds, where the
  // bundle is a static artifact whose identity can legitimately differ
  // from the live api's. In dev (`vite serve`), leave it undefined; the
  // help dialog falls through to the backend's live gitSha from
  // /api/health, which always reflects the same checkout vite is serving
  // from and updates after every `git pull`. See
  // src/web/components/ShortcutHelp.tsx for the fallback logic.
  define: command === "build"
    ? { __PI_REMOTE_GIT_SHA__: JSON.stringify(frontendGitSha) }
    : {},
  server: {
    hmr: hmrEnabled,
    allowedHosts,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
}));
