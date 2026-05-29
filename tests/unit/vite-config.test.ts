import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// History: the iPhone Safari pi-crust used to silently reload every time the user
// returned to it after a few minutes in the background. Every reload was
// preceded by an `sse-client-error` and a pagehide{persisted:false};
// navigationType was "reload"; localStorage was preserved (bootCount
// monotonically increments). That was the signature of a scripted
// location.reload() — and the only thing in the stack that called it on a
// stale WebSocket was Vite's HMR client.
//
// We previously fixed this by disabling HMR entirely. That works for
// remote-viewing use cases but breaks the self-edit workflow (agent edits a
// file → expects browser to update without a reload). The current strategy
// is to KEEP HMR on but suppress the reload-on-disconnect path
// client-side: src/web/utils/hmr-tame.ts intercepts Vite's
// `vite:beforeFullReload` event and calls preventDefault() when the tab is
// hidden or has just resumed from background.
//
// These tests pin both invariants so a future regression can't silently
// re-introduce either the iOS scroll loss or break self-edit HMR.

async function loadConfig(): Promise<unknown> {
  const config = (await import("../../vite.config.js")).default;
  const resolved = typeof config === "function"
    ? (config as unknown as (env: unknown) => unknown)({ mode: "development", command: "serve" })
    : config;
  return resolved instanceof Promise ? await resolved : resolved;
}

describe("vite.config", () => {
  beforeEach(() => {
    // Each test re-imports vite.config.ts with its desired env state.
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.VITE_PI_CRUST_HMR;
    delete process.env.VITE_PI_CRUST_PROXY_TARGET;
    vi.resetModules();
  });

  it("enables HMR by default to support the self-edit workflow", async () => {
    delete process.env.VITE_PI_CRUST_HMR;
    const value = await loadConfig();
    const server = (value as { server?: { hmr?: unknown } }).server ?? {};
    expect(server.hmr).toBe(true);
  });

  it("disables HMR when VITE_PI_CRUST_HMR=0 is set (explicit opt-out)", async () => {
    process.env.VITE_PI_CRUST_HMR = "0";
    const value = await loadConfig();
    const server = (value as { server?: { hmr?: unknown } }).server ?? {};
    expect(server.hmr).toBe(false);
  });

  it("still proxies /api to the API server", async () => {
    const value = await loadConfig();
    const proxy = (value as { server?: { proxy?: Record<string, unknown> } }).server?.proxy ?? {};
    expect(proxy["/api"]).toBeDefined();
  });

  it("proxies Socket.IO through the same Vite origin in dev", async () => {
    const value = await loadConfig();
    const proxy = (value as { server?: { proxy?: Record<string, unknown> } }).server?.proxy ?? {};

    // Regression guard for pi-crust-dev's default same-origin mode:
    // the browser connects to /socket.io/ on the Vite origin (:5173), not to
    // the API port directly. If this proxy is missing, Socket.IO silently fails
    // and the app drops into SSE fallback with a possible missed-event gap.
    expect(proxy["/socket.io"]).toMatchObject({
      target: "http://127.0.0.1:8787",
      changeOrigin: true,
      ws: true,
    });
  });

  it("uses VITE_PI_CRUST_PROXY_TARGET for every dev proxy route", async () => {
    process.env.VITE_PI_CRUST_PROXY_TARGET = "http://127.0.0.1:9999";
    const value = await loadConfig();
    const proxy = (value as { server?: { proxy?: Record<string, { target?: string }> } }).server?.proxy ?? {};

    // Avoid split-brain dev configs where /api points at one API while
    // /socket.io points at another or falls back to the default port.
    expect(proxy["/api"]?.target).toBe("http://127.0.0.1:9999");
    expect(proxy["/socket.io"]?.target).toBe("http://127.0.0.1:9999");
  });
});

describe("HMR safety net", () => {
  // The hmr-tame module installs the `vite:beforeFullReload` suppression that
  // prevents iOS-style background-resume reloads from wiping scroll position.
  // It MUST be imported by main.tsx — and imported early enough that its
  // listener is registered before the inaugural HMR event can fire. Otherwise
  // we're one race away from re-introducing the iOS scroll bug.

  const mainTsx = fs.readFileSync(path.resolve(__dirname, "../../src/web/main.tsx"), "utf8");

  it("main.tsx imports the hmr-tame side-effect module", () => {
    expect(mainTsx).toMatch(/import\s+["']\.\/utils\/hmr-tame(\.js)?["']/);
  });

  it("hmr-tame is the first project-internal import (so its listener registers before HMR events)", () => {
    const importLines = mainTsx
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line))
      .filter((line) => /["']\.\//.test(line)); // project-internal only
    expect(importLines.length).toBeGreaterThan(0);
    expect(importLines[0]).toMatch(/hmr-tame/);
  });
});
