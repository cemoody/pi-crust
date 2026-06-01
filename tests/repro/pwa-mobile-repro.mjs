// Reproduce the iOS views of a pi-crust session as seen on an iPhone:
//   1. installed PWA (display-mode: standalone, edge-to-edge, status-bar overlay)
//   2. mobile Safari / Chrome on iOS (browser chrome around the app content)
//
// The hard part is the PWA "fold": when installed, `.session-dashboard` becomes
// `position: fixed; inset: 0` (fills the *visual* viewport exactly) and the
// header/composer are nudged by env(safe-area-inset-*). Chromium has no API to
// set iOS safe-area insets, so we (a) emulate `display-mode: standalone` via CDP
// and (b) inject the iPhone inset values the standalone CSS expects.
//
// Usage:
//   node tests/repro/pwa-mobile-repro.mjs \
//     [--url=http://100.117.0.75:5173/?session=<id>] [--out=tests/repro/out]
//
// Geometry targets an iPhone 12/13 mini: 375x812 logical pts, devicePixelRatio 2
// (matches the supplied 750x1624 screenshots).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const URL =
  args.url ??
  "http://100.117.0.75:5173/?session=019e7b25-3a7c-7a25-970c-92cf586b24f1";
const OUT = path.resolve(args.out ?? "tests/repro/out");

// iPhone 12/13 mini logical geometry.
const SCREEN = { width: 375, height: 812 };
const DPR = 2;
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// iOS safe-area insets for a notched iPhone in portrait.
const INSET = { top: 50, bottom: 34 };

// The PWA bug: on iOS the installed standalone shell sizes itself to the iOS
// `100vh` / large-viewport value, which is TALLER than the physical screen, and
// the fixed shell is anchored so BOTH ends fall outside the visible viewport:
//   - the top (`.active-session > header`: session title + fork/clone/edit/
//     delete) is clipped ABOVE the fold -> TOP_CLIP px
//   - the bottom (`.active-session-workspace` is a `1fr auto auto` grid, so the
//     prompt composer is the last row) is clipped BELOW the fold -> OVERSHOOT px
// Only the middle of the conversation shows -- no top bar, no text input --
// exactly what the device renders. Both are tunable to match a real device.
const TOP_CLIP = Number(args.topClip ?? 104); // header height pushed off the top
const OVERSHOOT = Number(args.overshoot ?? 150); // composer height pushed off the bottom

// Safari (top address-bar layout) chrome metrics, in logical pts.
const SAFARI = { topChrome: 102, bottomToolbar: 88 };
const SAFARI_CONTENT_H = SCREEN.height - SAFARI.topChrome - SAFARI.bottomToolbar;

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

/** Load the session, scroll the timeline to the very bottom, settle. */
async function loadSession(page) {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
  // Wait for the active session view (composer is the reliable anchor).
  await page
    .waitForSelector(".prompt-composer, .message-timeline", { timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  // Pin to the latest message: scroll the timeline + dismiss the jump pill.
  await page.evaluate(() => {
    const tl = document.querySelector(".message-timeline");
    if (tl) tl.scrollTop = tl.scrollHeight;
  });
  const jump = page.locator(".jump-to-latest");
  if (await jump.count()) await jump.first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const tl = document.querySelector(".message-timeline");
    if (tl) tl.scrollTop = tl.scrollHeight;
  });
  await page.waitForTimeout(400);
}

/** Emulate iOS PWA standalone: display-mode + injected safe-area insets. */
async function makeStandalone(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "display-mode", value: "standalone" }],
  });
  // Chromium can't synthesize iOS safe-area insets, and env() can't be set from
  // CSS, so mirror the standalone env()-driven rules with concrete iPhone px.
  //
  // We also reproduce the iOS `100vh` over-report. The intended fix is
  // `position: fixed; inset: 0` (pins the shell to the visible viewport, keeping
  // both header and composer on screen). The BUG is that on iOS the fixed shell
  // is laid out against the larger layout viewport and offset, so we anchor it
  // `TOP_CLIP`px above the viewport and make it tall enough that its bottom
  // (the composer) lands `OVERSHOOT`px below the fold. The header is clipped off
  // the top, the composer off the bottom; only the middle conversation shows.
  const shellH = SCREEN.height + TOP_CLIP + OVERSHOOT;
  await page.addStyleTag({
    content: `
      @media all {
        .sidebar-toggle--floating { top: ${INSET.top - 2}px !important; }
        .session-sidebar { padding-top: ${INSET.top}px !important; }
        .active-session > header { margin-top: ${INSET.top - 6}px !important; }
        .prompt-composer { padding-bottom: ${INSET.bottom}px !important; }
        .session-dashboard {
          position: fixed !important;
          left: 0 !important; right: 0 !important;
          top: -${TOP_CLIP}px !important;
          bottom: auto !important;
          height: ${shellH}px !important;
          min-height: 0 !important;
          padding-bottom: 0 !important;
        }
      }`,
  });
}

// ---- 1. Installed PWA (standalone) -----------------------------------------
{
  const context = await browser.newContext({
    viewport: SCREEN,
    deviceScaleFactor: DPR,
    isMobile: true,
    hasTouch: true,
    userAgent: IOS_UA,
  });
  const page = await context.newPage();
  await makeStandalone(context, page);
  await loadSession(page);
  // Re-apply standalone overrides (the app re-renders after data loads).
  await makeStandalone(context, page);
  // Keep the OUTER document scrolled to the top: the over-tall shell means the
  // composer hangs off the bottom; scrolling would cheat it back into view.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  // Screenshot only the visible screen (NOT fullPage) so the composer, which is
  // laid out below the fold, is correctly absent -- matching the device.
  const appShot = await page.screenshot({
    clip: { x: 0, y: 0, width: SCREEN.width, height: SCREEN.height },
  });
  await page.screenshot({ path: path.join(OUT, "pwa-standalone-raw.png"), fullPage: true });
  await context.close();

  // Compose the iOS status-bar overlay (black-translucent) + home indicator.
  await composite(
    appShot,
    chromeStandalone(),
    path.join(OUT, "pwa-standalone.png"),
  );
  console.log("wrote pwa-standalone.png");
}

// ---- 2. Mobile Safari / Chrome on iOS --------------------------------------
{
  const context = await browser.newContext({
    viewport: { width: SCREEN.width, height: SAFARI_CONTENT_H },
    deviceScaleFactor: DPR,
    isMobile: true,
    hasTouch: true,
    userAgent: IOS_UA,
  });
  const page = await context.newPage();
  await loadSession(page);
  const appShot = await page.screenshot();
  await context.close();

  await composite(appShot, chromeSafari(), path.join(OUT, "safari-ios.png"));
  console.log("wrote safari-ios.png");
}

await browser.close();

// ---------------------------------------------------------------------------
// Compositor: render the simulated iOS chrome HTML with the app screenshot
// slotted into its content region, then screenshot at the device DPR.
// ---------------------------------------------------------------------------
async function composite(appPng, chrome, outPath) {
  const ctx = await browser.newContext({
    viewport: SCREEN,
    deviceScaleFactor: DPR,
  });
  const page = await ctx.newPage();
  const dataUri = `data:image/png;base64,${appPng.toString("base64")}`;
  await page.setContent(chrome(dataUri), { waitUntil: "load" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: outPath });
  await ctx.close();
}

function statusBar(dark = false) {
  const fg = dark ? "#000" : "#000";
  return `
  <div class="statusbar" style="color:${fg}">
    <div class="time">7:13</div>
    <div class="icons">
      <svg width="18" height="12" viewBox="0 0 18 12"><g fill="currentColor">
        <rect x="0" y="7" width="3" height="5" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/>
        <rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1" opacity="0.3"/>
      </g></svg>
      <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.2c2.3 0 4.4.9 6 2.4l1.3-1.4C13.9 1.3 11.3.2 8.5.2S3.1 1.3 1.2 3.2L2.5 4.6c1.6-1.5 3.7-2.4 6-2.4zm0 3.4c1.3 0 2.5.5 3.4 1.4l1.3-1.4C13 4.7 10.9 3.9 8.5 3.9S4 4.7 2.8 5.9L4.1 7.3C5 6.4 6.2 5.6 8.5 5.6zm0 3.3c.7 0 1.3.3 1.8.8l-1.8 1.9-1.8-1.9c.5-.5 1.1-.8 1.8-.8z"/></svg>
      <svg width="28" height="13" viewBox="0 0 28 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="16" height="9" rx="1.5" fill="currentColor"/><rect x="25" y="4" width="2" height="5" rx="1" fill="currentColor" opacity="0.5"/></svg>
    </div>
  </div>`;
}

function baseCss() { return `
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  html,body{width:${SCREEN.width}px;height:${SCREEN.height}px;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif;}
  .statusbar{position:absolute;top:0;left:0;right:0;z-index:10;height:${INSET.top}px;display:flex;align-items:flex-end;justify-content:space-between;padding:0 28px 8px;}
  .statusbar .time{font-weight:600;font-size:16px;letter-spacing:.3px}
  .statusbar .icons{display:flex;align-items:center;gap:6px}
  .content{position:absolute;left:0;width:${SCREEN.width}px;overflow:hidden}
  .content img{width:${SCREEN.width}px;display:block}
`; }

// Installed PWA: only the translucent status bar overlays the top; app runs
// edge-to-edge. A home indicator sits at the bottom over the composer padding.
function chromeStandalone() {
  return (img) => `<!doctype html><html><head><meta charset=utf8><style>
    ${baseCss()}
    body{background:#faf9f5}
    .content{top:0;height:${SCREEN.height}px}
    .home-indicator{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:134px;height:5px;border-radius:3px;background:#000;opacity:.85;z-index:5}
  </style></head><body>
    <div class="content"><img src="${img}"></div>
    ${statusBar()}
    <div class="home-indicator"></div>
  </body></html>`;
}

// Mobile Safari (top address-bar layout) + bottom toolbar.
function chromeSafari() {
  return (img) => `<!doctype html><html><head><meta charset=utf8><style>
    ${baseCss()}
    body{background:#f2f1ed}
    .topchrome{position:absolute;top:0;left:0;right:0;height:${SAFARI.topChrome}px;background:#f7f6f2;border-bottom:1px solid #dcdad3;z-index:5}
    .addressbar{position:absolute;z-index:10;top:${INSET.top + 4}px;left:14px;right:14px;height:38px;background:#e6e4de;border-radius:12px;display:flex;align-items:center;padding:0 14px;color:#1c1c1e;font-size:16px;}
    .addressbar .aa{color:#666;font-size:17px}
    .addressbar .url{flex:1;text-align:center;font-weight:400;white-space:nowrap;overflow:hidden}
    .addressbar .url b{font-weight:400}
    .addressbar .share{color:#444}
    .content{top:${SAFARI.topChrome}px;height:${SAFARI_CONTENT_H}px}
    .toolbar{position:absolute;bottom:0;left:0;right:0;height:${SAFARI.bottomToolbar}px;background:#f7f6f2;border-top:1px solid #dcdad3;display:flex;align-items:flex-start;justify-content:space-around;padding-top:14px;z-index:5;color:#1f1f1f}
    .toolbar svg{display:block}
    .toolbar .dim{opacity:.32}
    .toolbar .tabs{border:2px solid #1f1f1f;border-radius:6px;width:30px;height:26px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600}
    .toolbar .add{width:42px;height:42px;border-radius:50%;background:#e6e4de;display:flex;align-items:center;justify-content:center;margin-top:-6px}
    .home-indicator{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:134px;height:5px;border-radius:3px;background:#000;opacity:.85;z-index:6}
  </style></head><body>
    <div class="content"><img src="${img}"></div>
    <div class="topchrome"></div>
    ${statusBar()}
    <div class="addressbar">
      <span class="aa">✦</span>
      <span class="url">⚠ <b>100.117.0.75:5173</b></span>
      <svg class="share" width="20" height="22" viewBox="0 0 20 22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 14V3M10 3L6.5 6.5M10 3l3.5 3.5"/><path d="M5 9H3v10h14V9h-2"/></svg>
    </div>
    <div class="toolbar">
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M16 4L7 13l9 9"/></svg>
      <svg class="dim" width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10 4l9 9-9 9"/></svg>
      <div class="add"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4v14M4 11h14"/></svg></div>
      <div class="tabs">20</div>
      <svg width="26" height="26" viewBox="0 0 26 26" fill="currentColor"><circle cx="5" cy="13" r="2.4"/><circle cx="13" cy="13" r="2.4"/><circle cx="21" cy="13" r="2.4"/></svg>
    </div>
    <div class="home-indicator"></div>
  </body></html>`;
}
