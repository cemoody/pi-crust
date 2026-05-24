/**
 * Records a short mobile-viewport GIF of the D3 force-graph artifact being
 * dragged around to demonstrate that it is live and interactive.
 *
 *   npm run promo:gif
 *     -> promo-screenshots/animations/iphone-d3-drag.gif
 *
 * How it works:
 *   1. Spawns its own mock API (port 9791) + Vite dev server (port 5181)
 *      using the same seed-promo-sessions.mjs as the playwright promo suite.
 *   2. Launches a headless chromium with an iPhone-14-shaped viewport,
 *      recordVideo enabled.
 *   3. Navigates into the "Module map" session and waits for the D3 svg.
 *   4. postMessages into the sandboxed iframe to read actual node positions
 *      (sandbox="allow-scripts" blocks DOM access but postMessage works),
 *      maps them into screen coordinates, and scripts page.mouse drag
 *      gestures on real nodes \u2014 with a fake cursor overlay so the recording
 *      shows the click trail.
 *   5. Closes the context to flush the webm, then ffmpegs it into a
 *      palette-optimised GIF.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sessionRoot = path.join(repoRoot, ".tmp/promo-gif-sessions");
const videoRoot = path.join(repoRoot, ".tmp/promo-gif-video");
const outDir = path.join(repoRoot, "promo-screenshots/animations");
const outGif = path.join(outDir, "iphone-d3-drag.gif");

const API_PORT = process.env.PROMO_GIF_API_PORT || "9791";
const VITE_PORT = process.env.PROMO_GIF_VITE_PORT || "5181";
const VIEWPORT = { width: 390, height: 844 };

async function rmrf(p) { try { await fs.rm(p, { recursive: true, force: true }); } catch {} }

function startProcess(cmd, args, env, label) {
  // no-pgid: one-shot command (recorder utility, never long-lived alongside the api)
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: repoRoot });
  child.stdout.on("data", (b) => process.stdout.write(`[${label}] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[${label}] ${b}`));
  return child;
}

async function waitForHttp(url, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not come up at ${url} within ${timeoutMs}ms`);
}

await rmrf(sessionRoot);
await rmrf(videoRoot);
await fs.mkdir(outDir, { recursive: true });

// 1. Seed (synchronous).
await new Promise((resolve, reject) => {
  // no-pgid: one-shot command (recorder utility, never long-lived alongside the api)
  const c = spawn("node", ["scripts/seed-promo-sessions.mjs"], {
    env: { ...process.env, PI_CRUST_PROJECT_ROOT: repoRoot, PI_CRUST_SESSION_ROOT: sessionRoot },
    cwd: repoRoot, stdio: "inherit",
  });
  c.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`seed exit ${code}`)));
});

// 2. API + Vite.
const apiProc = startProcess("npx", ["tsx", "src/server/http-api-server.ts"], {
  PI_CRUST_USE_MOCK: "1",
  PI_CRUST_PROJECT_ROOT: repoRoot,
  PI_CRUST_SESSION_ROOT: sessionRoot,
  PI_CRUST_API_PORT: API_PORT,
}, "api");
const viteProc = startProcess("npx", ["vite", "--host", "127.0.0.1", "--port", VITE_PORT], {
  VITE_PI_CRUST_API_BASE: `http://127.0.0.1:${API_PORT}`,
}, "vite");

const shutdown = () => {
  try { apiProc.kill("SIGTERM"); } catch {}
  try { viteProc.kill("SIGTERM"); } catch {}
};
process.on("exit", shutdown);
process.on("SIGINT", () => { shutdown(); process.exit(1); });
process.on("SIGTERM", () => { shutdown(); process.exit(1); });

try {
  await waitForHttp(`http://127.0.0.1:${API_PORT}/api/health`, "api");
  await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, "vite");

  // 3. Browser + video.
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    recordVideo: { dir: videoRoot, size: VIEWPORT },
  });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[browser]", m.text()); });
  page.on("pageerror", (e) => console.log("[browser-pageerror]", e.message));

  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /Module map/ }).first().click();
  await page.waitForTimeout(600);

  // Wait for the iframe to actually paint the D3 graph.
  await page.locator('[data-testid="artifact-html"]').first().waitFor({ state: "attached" });
  await page.waitForFunction(() => {
    const ifr = document.querySelector('[data-testid="artifact-html"]');
    if (!ifr) return false;
    const r = ifr.getBoundingClientRect();
    return r.width > 100 && r.height > 100;
  }, undefined, { timeout: 10_000, polling: 100 });
  await page.waitForTimeout(1500); // let the D3 simulation finish settling

  // 4. Query node positions via postMessage (sandbox-safe).
  const meta = await page.evaluate(() => new Promise((resolve, reject) => {
    const ifr = document.querySelector('[data-testid="artifact-html"]');
    if (!ifr) return reject(new Error("iframe missing"));
    const timer = setTimeout(() => reject(new Error("getNodes timeout")), 5000);
    function onMessage(event) {
      if (!event.data || event.data.type !== "nodes") return;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      const r = ifr.getBoundingClientRect();
      resolve({
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        viewBox: event.data.viewBox,
        nodes: event.data.payload,
      });
    }
    window.addEventListener("message", onMessage);
    ifr.contentWindow.postMessage({ type: "getNodes" }, "*");
  }));

  // viewBox -> screen with preserveAspectRatio="xMidYMid meet": single scale,
  // letterboxed.
  const scale = Math.min(meta.rect.w / meta.viewBox.w, meta.rect.h / meta.viewBox.h);
  const offsetX = meta.rect.x + (meta.rect.w - meta.viewBox.w * scale) / 2;
  const offsetY = meta.rect.y + (meta.rect.h - meta.viewBox.h * scale) / 2;
  const toScreen = (n) => ({ x: offsetX + n.x * scale, y: offsetY + n.y * scale });

  // Inject a visible cursor overlay in the parent so the GIF shows a finger /
  // pointer trail. (Real OS cursor isn't visible in Playwright video.)
  await page.evaluate(() => {
    const c = document.createElement("div");
    c.id = "__promo_cursor__";
    c.style.cssText = "position:fixed; left:-100px; top:-100px; width:22px; height:22px; pointer-events:none; z-index:99999; border-radius:50%; background:radial-gradient(circle, rgba(124,92,255,0.95) 0%, rgba(124,92,255,0.55) 55%, rgba(124,92,255,0) 75%); box-shadow:0 0 0 2px rgba(255,255,255,0.7), 0 4px 14px rgba(15,23,42,0.35); transform:translate(-50%,-50%); transition:transform 70ms ease-out;";
    document.body.appendChild(c);
  });

  async function moveCursor(x, y) {
    await page.evaluate(({ x, y }) => {
      const el = document.getElementById("__promo_cursor__");
      if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
    }, { x, y });
  }

  async function dragNode(nodeId, dx, dy, steps = 18) {
    const node = meta.nodes.find((n) => n.id === nodeId);
    if (!node) { console.warn(`no node ${nodeId}`); return; }
    const start = toScreen(node);
    const end = { x: start.x + dx, y: start.y + dy };
    // Approach the node.
    await moveCursor(start.x - 60, start.y - 20);
    await page.mouse.move(start.x - 60, start.y - 20);
    await page.waitForTimeout(150);
    await moveCursor(start.x, start.y);
    await page.mouse.move(start.x, start.y, { steps: 6 });
    await page.waitForTimeout(120);
    await page.mouse.down();
    // Drag in small steps so the visible cursor + the underlying nodes move
    // smoothly together.
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Ease-in-out to make the motion feel hand-driven.
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const cx = start.x + (end.x - start.x) * e;
      const cy = start.y + (end.y - start.y) * e;
      await moveCursor(cx, cy);
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(28);
    }
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(220);
  }

  // 5. Choreography: three drag gestures on real nodes that exist in the
  // graph regardless of layout. We pick hub-y and leaf-y nodes for visual
  // contrast (the simulation will whip everything else around).
  const dragSequence = [
    { node: "SessionDashboard", dx:  70, dy: -55 },
    { node: "http-session-api", dx: -55, dy:  60 },
    { node: "VegaLiteChart",    dx:  35, dy:  45 },
  ];

  for (const step of dragSequence) await dragNode(step.node, step.dx, step.dy);

  // Park the cursor away and let the simulation settle for the tail of the GIF.
  await moveCursor(VIEWPORT.width - 30, VIEWPORT.height - 30);
  await page.waitForTimeout(900);

  await context.close();
  await browser.close();

  // 6. Convert webm -> GIF with a good palette.
  const files = await fs.readdir(videoRoot);
  const webm = files.find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error(`no webm in ${videoRoot}`);
  const webmPath = path.join(videoRoot, webm);
  const palettePath = path.join(videoRoot, "palette.png");

  await new Promise((resolve, reject) => {
  // no-pgid: one-shot command (recorder utility, never long-lived alongside the api)
    const c = spawn("ffmpeg", ["-y", "-i", webmPath, "-vf", "fps=18,scale=390:-1:flags=lanczos,palettegen=stats_mode=diff", palettePath], { stdio: "inherit" });
    c.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`palettegen ffmpeg exit ${code}`)));
  });

  await new Promise((resolve, reject) => {
  // no-pgid: one-shot command (recorder utility, never long-lived alongside the api)
    const c = spawn("ffmpeg", ["-y", "-i", webmPath, "-i", palettePath, "-lavfi", "fps=18,scale=390:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", "-loop", "0", outGif], { stdio: "inherit" });
    c.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`paletteuse ffmpeg exit ${code}`)));
  });

  const stat = await fs.stat(outGif);
  console.log(`\nwrote ${outGif} (${(stat.size / 1024).toFixed(0)} KB)`);
} finally {
  shutdown();
  // give children a moment to die so the next run doesn't collide on the port
  await new Promise((r) => setTimeout(r, 500));
}
