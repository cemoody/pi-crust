/**
 * Integration test for bin/pi-crust-dev.mjs.
 *
 * Pins the contract that someone running
 *
 *   npx -y -p github:cemoody/pi-crust pi-crust-dev
 *
 * gets:
 *
 *   1. Both api (on PI_CRUST_API_PORT) and vite (on PI_CRUST_WEB_PORT)
 *      come up healthy.
 *   2. Vite's `/api/*` proxy reaches the api.
 *   3. SIGTERM to the launcher tears down BOTH children atomically, and
 *      both ports are freed afterwards. (If this regresses, the next npx
 *      invocation would fail with EADDRINUSE.)
 *
 * Uses the mock adapter so the test doesn't depend on the `pi` binary,
 * and a fresh tempdir for sessionRoot so it doesn't touch the host's
 * ~/.pi/agent/sessions.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LAUNCHER = path.resolve(__dirname, "../../bin/pi-crust-dev.mjs");
const REPO_ROOT = path.resolve(__dirname, "../..");

let launcher: ChildProcess | null = null;
const tempDirs: string[] = [];
const logChunks: string[] = [];

afterEach(async () => {
  if (launcher && !launcher.killed) {
    launcher.kill("SIGKILL");
    await new Promise<void>((resolve) => launcher!.once("exit", () => resolve()));
  }
  launcher = null;
  for (const d of tempDirs.splice(0)) {
    try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  logChunks.length = 0;
});

interface Ports { readonly api: number; readonly web: number }
function pickPorts(): Ports {
  // Picky-but-good-enough: random high ports unlikely to collide with the
  // dev box's :5173 / :8787 or playwright's :5174 / :9787.
  const api = 28000 + Math.floor(Math.random() * 1000);
  const web = 29000 + Math.floor(Math.random() * 1000);
  return { api, web };
}

async function startLauncher(opts: { ports: Ports; sessionRoot: string }): Promise<void> {
  launcher = spawn(process.execPath, [LAUNCHER], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_CRUST_API_PORT: String(opts.ports.api),
      PI_CRUST_WEB_PORT: String(opts.ports.web),
      PI_CRUST_DEV_HOST: "127.0.0.1",
      PI_CRUST_USE_MOCK: "1",
      PI_CRUST_PROJECT_ROOT: opts.sessionRoot,
      PI_CRUST_SESSION_ROOT: opts.sessionRoot,
      PI_CRUST_OPEN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  launcher.stdout!.on("data", (c) => logChunks.push(c.toString()));
  launcher.stderr!.on("data", (c) => logChunks.push(c.toString()));
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = `HTTP ${res.status}`;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForHttp ${url} timed out. last error: ${lastErr}\nlauncher log:\n${logChunks.join("")}`);
}

async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      // Any non-ECONNREFUSED means the port is still bound.
      await res.text().catch(() => undefined);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { cause?: { code?: string } })?.cause?.code
        ?? (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED") return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`port ${port} did not free in ${timeoutMs}ms`);
}

describe("bin/pi-crust-dev.mjs", () => {
  it("brings up vite + api so both /api/health and the pi-crust respond", async () => {
    const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "pi-crust-dev-launcher-"));
    tempDirs.push(sessionRoot);
    const ports = pickPorts();

    await startLauncher({ ports, sessionRoot });

    // api responds directly
    const apiRes = await waitForHttp(`http://127.0.0.1:${ports.api}/api/health`);
    const health = await apiRes.json() as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.adapter).toBe("mock");

    // vite serves index.html
    const webRes = await waitForHttp(`http://127.0.0.1:${ports.web}/`);
    const html = await webRes.text();
    expect(html).toMatch(/<!doctype html>/i);

    // vite proxies /api/* to the api
    const proxiedRes = await fetch(`http://127.0.0.1:${ports.web}/api/health`);
    expect(proxiedRes.status).toBe(200);
    const proxied = await proxiedRes.json() as Record<string, unknown>;
    expect(proxied.ok).toBe(true);
  }, 60_000);

  it("SIGTERM to the launcher tears down BOTH children and frees both ports", async () => {
    const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "pi-crust-dev-launcher-"));
    tempDirs.push(sessionRoot);
    const ports = pickPorts();

    await startLauncher({ ports, sessionRoot });
    await waitForHttp(`http://127.0.0.1:${ports.api}/api/health`);
    await waitForHttp(`http://127.0.0.1:${ports.web}/`);

    expect(launcher).toBeTruthy();
    launcher!.kill("SIGTERM");
    await new Promise<void>((resolve) => launcher!.once("exit", () => resolve()));

    // After the launcher exits, both ports must be free for the next
    // npx invocation. This is the invariant that protects against the
    // npm-doesn't-forward-signals class of bug we hit twice before.
    await waitForPortFree(ports.api);
    await waitForPortFree(ports.web);
  }, 60_000);
});
