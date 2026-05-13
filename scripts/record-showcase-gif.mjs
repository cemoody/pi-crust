/**
 * Records a tall, landscape-iPad-sized GIF that scrolls through the
 * "Showcase tour" promo session — markdown pitch, then a live D3
 * streaming-sparklines animation, then a seaborn statistical figure,
 * then an interactive signal-generator widget whose buttons we click with
 * a visible fake cursor.
 *
 *   npm run promo:tour
 *     -> promo-screenshots/animations/showcase-tour.gif
 *
 * Architecture mirrors scripts/record-d3-gif.mjs:
 *   1. Seed mock sessions + boot mock API + Vite on dedicated ports.
 *   2. Launch chromium with recordVideo at iPad-landscape size.
 *   3. Inject a fake cursor overlay (Playwright's video doesn't include the
 *      OS cursor).
 *   4. Programmatically scroll the conversation pane, pausing on each
 *      artifact, then aim real mouse clicks at the widget's buttons by
 *      reading their iframe-relative positions over postMessage.
 *   5. Convert the resulting webm to a palette-optimised GIF with ffmpeg.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sessionRoot = path.join(repoRoot, ".tmp/promo-tour-sessions");
const videoRoot = path.join(repoRoot, ".tmp/promo-tour-video");
const outDir = path.join(repoRoot, "promo-screenshots/animations");
const outGif = path.join(outDir, "showcase-tour.gif");

const API_PORT = process.env.PROMO_TOUR_API_PORT || "9793";
const VITE_PORT = process.env.PROMO_TOUR_VITE_PORT || "5183";
const VIEWPORT = { width: 1024, height: 768 };

async function rmrf(p) { try { await fs.rm(p, { recursive: true, force: true }); } catch {} }

function startProcess(cmd, args, env, label) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: repoRoot });
  child.stdout.on("data", (b) => process.stdout.write(`[${label}] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[${label}] ${b}`));
  return child;
}

async function waitForHttp(url, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not come up at ${url} within ${timeoutMs}ms`);
}

await rmrf(sessionRoot);
await rmrf(videoRoot);
await fs.mkdir(outDir, { recursive: true });

// 1. Seed.
await new Promise((resolve, reject) => {
  const c = spawn("node", ["scripts/seed-promo-sessions.mjs"], {
    env: { ...process.env, PI_REMOTE_PROJECT_ROOT: repoRoot, PI_REMOTE_SESSION_ROOT: sessionRoot },
    cwd: repoRoot, stdio: "inherit",
  });
  c.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`seed exit ${code}`)));
});

// 2. API + Vite.
const apiProc = startProcess("npx", ["tsx", "src/server/http-api-server.ts"], {
  PI_REMOTE_USE_MOCK: "1",
  PI_REMOTE_PROJECT_ROOT: repoRoot,
  PI_REMOTE_SESSION_ROOT: sessionRoot,
  PI_REMOTE_API_PORT: API_PORT,
}, "api");
const viteProc = startProcess("npx", ["vite", "--host", "127.0.0.1", "--port", VITE_PORT], {
  VITE_PI_REMOTE_API_BASE: `http://127.0.0.1:${API_PORT}`,
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

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoRoot, size: VIEWPORT },
  });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[browser]", m.text()); });
  page.on("pageerror", (e) => console.log("[browser-pageerror]", e.message));

  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /Showcase tour/ }).first().click();
  await page.waitForTimeout(800);

  // Fake cursor overlay (Playwright video doesn't show the OS cursor).
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

  // Discover the scrollable timeline pane. The conversation timeline is the
  // element that actually scrolls — figure it out at runtime so we don't
  // hard-code a brittle selector.
  const scroller = await page.evaluateHandle(() => {
    // Walk up from a known artifact to find the nearest scrollable ancestor.
    const anchor = document.querySelector('[data-testid="artifact-markdown"]') ||
                   document.querySelector('[data-testid="artifact-html"]') ||
                   document.querySelector('.message-timeline') ||
                   document.querySelector('main');
    let el = anchor;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    // Fallback to the document.
    return document.scrollingElement || document.documentElement;
  });

  async function scrollBy(dy, durationMs) {
    // Smooth scroll the discovered container.
    const steps = Math.max(8, Math.round(durationMs / 30));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const delta = (e - (i === 1 ? 0 : ((i - 1) / steps < 0.5 ? 2 * ((i - 1) / steps) ** 2 : 1 - Math.pow(-2 * ((i - 1) / steps) + 2, 2) / 2))) * dy;
      await scroller.evaluate((el, d) => { el.scrollBy({ top: d, left: 0, behavior: "instant" }); }, delta);
      await page.waitForTimeout(durationMs / steps);
    }
  }

  async function scrollIntoView(selector, opts = {}) {
    const handle = await page.locator(selector).first().elementHandle();
    if (!handle) return null;
    await scroller.evaluate((el, h) => {
      const sr = el.getBoundingClientRect();
      const tr = h.getBoundingClientRect();
      const target = tr.top - sr.top - (sr.height * 0.18); // bring top of artifact ~18% from the top of the pane
      el.scrollBy({ top: target, left: 0, behavior: "smooth" });
    }, handle);
    await page.waitForTimeout(opts.dwellMs ?? 600);
    return handle;
  }

  // Wait for the markdown artifact + the streaming D3 + the widget to all
  // have mounted (the seaborn image just needs a non-zero rect; data URL is sync).
  await page.locator('[data-testid="artifact-markdown"]').first().waitFor({ state: "attached", timeout: 10_000 });
  await page.locator('[data-testid="artifact-html"]').first().waitFor({ state: "attached", timeout: 10_000 });
  await page.locator('[data-testid="artifact-image"]').first().waitFor({ state: "attached", timeout: 10_000 });
  // Final widget iframe (last [data-testid="artifact-html"]) — wait until it has a srcdoc.
  await page.waitForFunction(() => {
    const ifrs = document.querySelectorAll('[data-testid="artifact-html"]');
    return ifrs.length >= 2 && (ifrs[ifrs.length - 1].getAttribute("srcdoc") || "").length > 100;
  }, undefined, { timeout: 10_000, polling: 100 });
  await page.waitForTimeout(800);

  // Park cursor in a neutral spot.
  await moveCursor(VIEWPORT.width * 0.5, VIEWPORT.height * 0.5);

  // === Choreography =====================================================

  // Stage 1: dwell on markdown briefly.
  await page.waitForTimeout(1100);

  // Stage 2: scroll down to the live D3 streaming chart, then dwell so the
  // sparklines visibly stream.
  const d3IFrames = page.locator('[data-testid="artifact-html"]');
  const d3Frame = d3IFrames.first(); // first HTML artifact = D3 stream
  await scrollIntoView(`[data-testid="artifact-html"]:nth-of-type(1)`, { dwellMs: 200 }).catch(async () => {
    await d3Frame.scrollIntoViewIfNeeded();
  });
  // Generic: scroll by half a viewport.
  await scrollBy(VIEWPORT.height * 0.55, 900);
  await page.waitForTimeout(1700); // let the streaming animation play

  // Stage 3: scroll down to the seaborn image and dwell.
  await scrollBy(VIEWPORT.height * 0.75, 1100);
  await page.waitForTimeout(1500);

  // Stage 4: scroll to the widget. Then click controls with the visible cursor.
  await scrollBy(VIEWPORT.height * 0.85, 1100);
  await page.waitForTimeout(600);

  // Find the *widget* iframe (the last text/html artifact in the conversation).
  const widgetHandle = await page.evaluateHandle(() => {
    const all = document.querySelectorAll('[data-testid="artifact-html"]');
    return all[all.length - 1];
  });

  // Make sure the widget is fully on screen by recentering it.
  await page.evaluate((ifr) => {
    ifr.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }, widgetHandle);
  await page.waitForTimeout(900);

  // Ask the widget for control positions via postMessage.
  const controls = await page.evaluate((ifr) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("getControls timeout")), 5000);
    function onMessage(event) {
      if (!event.data || event.data.type !== "controls") return;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      const rect = ifr.getBoundingClientRect();
      resolve({ rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, items: event.data.payload });
    }
    window.addEventListener("message", onMessage);
    ifr.contentWindow.postMessage({ type: "getControls" }, "*");
  }), widgetHandle);

  function locateControl(id) {
    const c = controls.items.find((c) => c.id === id);
    if (!c) return null;
    return {
      x: controls.rect.x + c.x + c.w / 2,
      y: controls.rect.y + c.y + c.h / 2,
    };
  }

  async function clickControl(id, settleMs = 700) {
    const p = locateControl(id);
    if (!p) { console.warn(`no control ${id}`); return; }
    // approach
    await moveCursor(p.x - 50, p.y + 30);
    await page.mouse.move(p.x - 50, p.y + 30);
    await page.waitForTimeout(180);
    await moveCursor(p.x, p.y);
    await page.mouse.move(p.x, p.y, { steps: 8 });
    await page.waitForTimeout(140);
    await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
    await page.waitForTimeout(settleMs);
  }

  // Click sequence: square, saw, noise, then pause.
  await clickControl("wave-square");
  await clickControl("wave-saw");
  await clickControl("wave-noise");
  await clickControl("wave-sine");
  await clickControl("playpause", 900);

  // Park the cursor and let the final frame breathe.
  await moveCursor(VIEWPORT.width - 40, VIEWPORT.height - 30);
  await page.waitForTimeout(700);

  await context.close();
  await browser.close();

  // 6. Convert webm -> GIF.
  const files = await fs.readdir(videoRoot);
  const webm = files.find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error(`no webm in ${videoRoot}`);
  const webmPath = path.join(videoRoot, webm);
  const palettePath = path.join(videoRoot, "palette.png");

  // Downscale for a reasonable GIF size; keep aspect ratio.
  const SCALE_W = 720;

  await new Promise((resolve, reject) => {
    const c = spawn("ffmpeg", ["-y", "-i", webmPath, "-vf", `fps=14,scale=${SCALE_W}:-1:flags=lanczos,palettegen=stats_mode=diff`, palettePath], { stdio: "inherit" });
    c.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`palettegen ffmpeg exit ${code}`)));
  });
  await new Promise((resolve, reject) => {
    const c = spawn("ffmpeg", ["-y", "-i", webmPath, "-i", palettePath, "-lavfi", `fps=14,scale=${SCALE_W}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", outGif], { stdio: "inherit" });
    c.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`paletteuse ffmpeg exit ${code}`)));
  });

  const stat = await fs.stat(outGif);
  console.log(`\nwrote ${outGif} (${(stat.size / 1024).toFixed(0)} KB)`);
} finally {
  shutdown();
  await new Promise((r) => setTimeout(r, 500));
}
