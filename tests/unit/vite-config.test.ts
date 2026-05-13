import { describe, expect, it } from "vitest";

// Repro from real-world telemetry on the dev box: the iPhone Safari WUI tab
// silently reloads every time the user returns to it after a few minutes in
// the background. Every reload is preceded by an `sse-client-error` and a
// pagehide{persisted:false}; navigationType is "reload"; localStorage is
// preserved (bootCount monotonically increments). That is the signature of a
// scripted location.reload() — and the only thing in the stack that calls
// it on a stale WebSocket is Vite's HMR client.
//
// For the remote-control deployment we do NOT need HMR (the user reads on a
// phone, code editing happens elsewhere), so we disable it. This test pins
// the config so a future re-enable can't sneak in silently.

import config from "../../vite.config.js";

describe("vite.config", () => {
  it("disables HMR by default to avoid iOS-Safari background-resume reloads", async () => {
    const resolved = typeof config === "function"
      ? (config as unknown as (env: unknown) => unknown)({ mode: "development", command: "serve" })
      : config;
    const value = resolved instanceof Promise ? await resolved : resolved;
    const server = (value as { server?: { hmr?: unknown } }).server ?? {};
    expect(server.hmr).toBe(false);
  });

  it("still proxies /api to the API server", async () => {
    const resolved = typeof config === "function"
      ? (config as unknown as (env: unknown) => unknown)({ mode: "development", command: "serve" })
      : config;
    const value = resolved instanceof Promise ? await resolved : resolved;
    const proxy = (value as { server?: { proxy?: Record<string, unknown> } }).server?.proxy ?? {};
    expect(proxy["/api"]).toBeDefined();
  });
});
