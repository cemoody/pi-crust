/**
 * Seed mock sessions used for promo/marketing screenshots.
 *
 * These sessions are tuned to look pretty in README hero shots:
 * - one rich agent run with text + thinking + a tool call + a vega-lite
 *   artifact rendered inline
 * - one with a self-contained HTML artifact (Plotly-style chart)
 * - one with an image artifact
 * - one cron-rooted "scheduled job" session
 *
 * Used by tests/playwright/promo-screenshots.spec.ts via the standard
 * mock playwright webServer setup.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.PI_REMOTE_SESSION_ROOT ?? ".tmp/playwright-sessions");
const cwd = path.resolve(process.env.PI_REMOTE_PROJECT_ROOT ?? process.cwd());
await fs.mkdir(root, { recursive: true });

async function loadAsDataUrl(relPath, mime) {
  const abs = path.resolve(here, "..", relPath);
  const buf = await fs.readFile(abs);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function writeSession({ id, name, messages, order }) {
  const sessionFile = path.join(root, `${String(order).padStart(13, "0")}_${id}.mock-session.json`);
  await fs.writeFile(sessionFile, JSON.stringify({
    id,
    cwd,
    sessionFile,
    sessionName: name,
    messages,
    lastActivity: Date.now() + order,
  }, null, 2) + "\n");
  console.log(`seeded ${sessionFile}`);
}

// ────────────────────────────────────────────────────────────────────────
// Session 1: Plotting (Vega-Lite artifact)
// ────────────────────────────────────────────────────────────────────────

const vegaSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  description: "Daily 99th-percentile request latency over the last 30 days",
  width: "container",
  height: 220,
  data: {
    values: Array.from({ length: 30 }, (_, i) => {
      const seed = Math.sin(i * 0.7) * 0.5 + 0.5;
      const noise = (Math.sin(i * 1.7) + Math.cos(i * 2.3)) * 18;
      const baseline = 110 + i * 0.6;
      return {
        day: `2026-04-${String(i + 1).padStart(2, "0")}`,
        p99: Math.max(60, Math.round(baseline + seed * 35 + noise)),
        p50: Math.max(20, Math.round(baseline * 0.45 + noise * 0.3)),
      };
    }),
  },
  transform: [
    { fold: ["p50", "p99"], as: ["percentile", "ms"] },
  ],
  mark: { type: "line", point: { filled: true, size: 50 }, interpolate: "monotone" },
  encoding: {
    x: { field: "day", type: "temporal", title: null, axis: { format: "%b %d" } },
    y: { field: "ms", type: "quantitative", title: "latency (ms)" },
    color: {
      field: "percentile",
      type: "nominal",
      scale: { domain: ["p50", "p99"], range: ["#94a3b8", "#7c5cff"] },
      legend: { title: null, orient: "top" },
    },
  },
  config: { view: { stroke: null }, axis: { labelFontSize: 11, titleFontSize: 11 } },
};

await writeSession({
  order: 1,
  id: "promo-vega-latency",
  name: "Latency investigation",
  messages: [
    {
      role: "user",
      content: "Pull the last 30 days of request p99/p50 from the warehouse and chart them so I can see where the regression started.",
      timestamp: 1700000000100,
    },
    {
      role: "assistant",
      content: "I'll query the daily latency rollup and plot p50 + p99 inline.",
      timestamp: 1700000000200,
    },
    {
      role: "tool",
      content: "Query OK.  30 rows.  median p99 = 167 ms.  max p99 = 224 ms (2026-04-22).",
      timestamp: 1700000000300,
      tool: {
        id: "tool-1",
        name: "bash",
        args: { command: "duckdb warehouse.db -c 'select day, p50_ms, p99_ms from svc_latency_daily order by day desc limit 30'" },
        status: "success",
        output: "Query OK.  30 rows.  median p99 = 167 ms.  max p99 = 224 ms (2026-04-22).",
      },
    },
    {
      role: "custom",
      content: "Daily latency (p50 vs p99) — regression visible around 2026-04-22.",
      timestamp: 1700000000400,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: "promo-vega-latency-group",
        caption: "Daily latency (p50 vs p99) — regression visible around 2026-04-22.",
        artifacts: [
          { mime: "application/vnd.vega-lite.v5+json", spec: vegaSpec },
          { mime: "text/plain", text: "vega-lite line chart of p50 vs p99 latency over 30 days" },
        ],
      },
    },
    {
      role: "assistant",
      content: "Regression starts 2026-04-22 — p99 jumps from ~165 ms to 220+ ms while p50 stays flat. That timing lines up with deploy `web@4d2c1f`. Want me to diff that release?",
      timestamp: 1700000000500,
    },
  ],
});

// ────────────────────────────────────────────────────────────────────────
// Session 2: HTML artifact (self-contained mini dashboard)
// ────────────────────────────────────────────────────────────────────────

const htmlReport = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 16px 18px; font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #0f172a; background: #fbf7ec; }
  h2 { margin: 0 0 12px; font-size: 14px; letter-spacing: 0.02em; text-transform: uppercase; color: #475569; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 14px; }
  .tile { background: white; border-radius: 10px; padding: 10px 12px; box-shadow: 0 1px 0 rgba(15,23,42,0.06); }
  .tile .label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 22px; font-weight: 600; margin-top: 4px; font-feature-settings: "tnum"; }
  .tile.good .value { color: #16a34a; } .tile.bad .value { color: #dc2626; }
  .bar { height: 6px; background: #e2e8f0; border-radius: 999px; overflow: hidden; margin-top: 8px; }
  .bar > span { display: block; height: 100%; background: linear-gradient(90deg, #7c5cff, #06b6d4); border-radius: 999px; }
  footer { margin-top: 14px; font-size: 11px; color: #64748b; }
</style></head><body>
  <h2>Cluster utilization · last 60 min</h2>
  <div class="grid">
    <div class="tile good"><div class="label">Active pods</div><div class="value">412</div><div class="bar"><span style="width:78%"></span></div></div>
    <div class="tile"><div class="label">CPU saturation</div><div class="value">63%</div><div class="bar"><span style="width:63%"></span></div></div>
    <div class="tile bad"><div class="label">P99 latency</div><div class="value">221 ms</div><div class="bar"><span style="width:88%"></span></div></div>
    <div class="tile good"><div class="label">Error rate</div><div class="value">0.04%</div><div class="bar"><span style="width:4%"></span></div></div>
  </div>
  <footer>Generated by ops-report skill · 2026-05-12 18:42 UTC</footer>
</body></html>`;

await writeSession({
  order: 2,
  id: "promo-html-dashboard",
  name: "Cluster sweep",
  messages: [
    { role: "user", content: "How's the cluster doing right now? Give me a quick at-a-glance summary I can paste in the standup channel.", timestamp: 1700000010100 },
    { role: "assistant", content: "Running the ops-report skill — it'll spit out a self-contained HTML tile that renders inline.", timestamp: 1700000010200 },
    {
      role: "custom",
      content: "Cluster utilization (last 60 min)",
      timestamp: 1700000010400,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: "promo-html-dashboard-group",
        caption: "Cluster utilization · last 60 min",
        artifacts: [
          { mime: "text/html", html: htmlReport, height: 220 },
          { mime: "text/plain", text: "Cluster utilization dashboard (HTML)" },
        ],
      },
    },
    { role: "assistant", content: "P99 is elevated (221 ms) but error rate is fine. I'd watch the latency tile for the next 10 min before paging anyone.", timestamp: 1700000010500 },
  ],
});

// ────────────────────────────────────────────────────────────────────────
// Session 3: Cron-rooted (looks like a scheduled run)
// ────────────────────────────────────────────────────────────────────────

await writeSession({
  order: 3,
  id: "promo-cron-dependabot",
  name: "cron: dependabot",
  messages: [
    { role: "user", content: "# Weekly Dependabot sweep\n\nQXO only. Single-shot, fire-and-forget, don't ask questions.", timestamp: 1700000020100 },
    { role: "assistant", content: "Fetching open alerts scoped to verticals/qxo/**…", timestamp: 1700000020200 },
    {
      role: "tool",
      content: "23 open alerts.  Auto-fixable: 18.  Blocked: 5 (no upstream fix).",
      timestamp: 1700000020300,
      tool: {
        id: "tool-cron-1",
        name: "bash",
        args: { command: "gh api 'repos/braincompany/platform/dependabot/alerts?state=open' --paginate | jq …" },
        status: "success",
        output: "23 open alerts.  Auto-fixable: 18.  Blocked: 5 (no upstream fix).",
      },
    },
    { role: "assistant", content: "Opened PR #2731 with 18 fixes (bumps + lockfile re-resolves). CI is green. 5 alerts left in the manual-handling table.", timestamp: 1700000020400 },
  ],
});

// ────────────────────────────────────────────────────────────────────────
// Session 4: Plain conversation (for the "active session" hero shot)
// ────────────────────────────────────────────────────────────────────────

await writeSession({
  order: 4,
  id: "promo-conversation",
  name: "Drafting the postmortem",
  messages: [
    { role: "user", content: "Help me draft the postmortem for last Friday's checkout outage. Keep it factual, 4 sections: what happened, impact, root cause, follow-ups.", timestamp: 1700000030100 },
    { role: "assistant", content: "Here's a tight first pass. The CSV of impacted accounts is queued — I can attach it as a downloadable artifact if you want.\n\n**What happened.** At 14:07 UTC the payment-gateway client started returning 502s; the retry loop saturated the connection pool, so the entire checkout-api fleet returned 504s for ~9 minutes.\n\n**Impact.** 412 checkouts failed. ~31% of those completed on retry within the next 10 min. 9 carts were abandoned outright.\n\n**Root cause.** A canary deploy of `payments-client@2.7` shipped a tighter HTTP/2 ping timeout that conflicts with our shared LB's idle-conn reaper. We didn't catch it because the canary's traffic share (5%) was below our P99 alert sensitivity.\n\n**Follow-ups.**\n  1. Pin `payments-client` ping timeout via env. Already merged in #14922.\n  2. Lower P99 alert threshold for canary cohorts. Tracked in [INFRA-841](#).\n  3. Soak test before bumping shared LB minor versions. Owner: @nikolai.\n", timestamp: 1700000030200 },
    { role: "user", content: "Looks good — tighten the impact section, the 31% figure should reference the retry-success log.", timestamp: 1700000030300 },
    { role: "assistant", content: "Updated:\n\n> **Impact.** 412 checkouts failed during the 9-minute window. Of those, 128 (31%) succeeded on the user's next attempt — see `retry-success.log` (linked in the SRE drive). The remaining 284 either succeeded on a later same-day attempt or never came back.", timestamp: 1700000030400 },
  ],
});

// ───────────────────────────────────────────────────────────────────────
// Session 5: D3 force-directed graph (the “coolest D3 example you can find”).
//
// Self-contained HTML artifact pulls D3 v7 from a CDN inside a sandboxed
// iframe and renders an interactive force-directed dependency graph styled
// to look like the agent just analysed a small TypeScript codebase. Nodes
// drift, attract, repel, and snap into a steady layout that looks great
// in a phone-sized iframe (~340px) and on desktop.
// ───────────────────────────────────────────────────────────────────────

const graphNodes = [
  { id: "index",            group: "entry"   },
  { id: "router",           group: "entry"   },
  { id: "SessionDashboard", group: "ui"      },
  { id: "MessageTimeline",  group: "ui"      },
  { id: "PromptComposer",   group: "ui"      },
  { id: "CronPanel",        group: "ui"      },
  { id: "ConfigPanel",      group: "ui"      },
  { id: "VegaLiteChart",    group: "ui"      },
  { id: "ToolCard",         group: "ui"      },
  { id: "http-session-api", group: "net"     },
  { id: "EventSource",      group: "net"     },
  { id: "telemetry",        group: "net"     },
  { id: "pi-event-reducer", group: "state"   },
  { id: "session-store",    group: "state"   },
  { id: "draft-store",      group: "state"   },
  { id: "clipboard",        group: "utils"   },
  { id: "image-downscale",  group: "utils"   },
  { id: "markdown",         group: "utils"   },
  { id: "protocol",         group: "shared"  },
  { id: "limits",           group: "shared"  },
];

const graphLinks = [
  ["index", "router"], ["router", "SessionDashboard"], ["index", "telemetry"],
  ["SessionDashboard", "MessageTimeline"], ["SessionDashboard", "PromptComposer"],
  ["SessionDashboard", "CronPanel"], ["SessionDashboard", "ConfigPanel"],
  ["SessionDashboard", "http-session-api"], ["SessionDashboard", "pi-event-reducer"],
  ["SessionDashboard", "session-store"], ["SessionDashboard", "draft-store"],
  ["MessageTimeline", "VegaLiteChart"], ["MessageTimeline", "ToolCard"],
  ["MessageTimeline", "markdown"],
  ["PromptComposer", "clipboard"], ["PromptComposer", "image-downscale"],
  ["PromptComposer", "draft-store"],
  ["CronPanel", "http-session-api"],
  ["ConfigPanel", "http-session-api"],
  ["http-session-api", "protocol"], ["http-session-api", "EventSource"],
  ["http-session-api", "limits"],
  ["EventSource", "telemetry"], ["telemetry", "http-session-api"],
  ["pi-event-reducer", "protocol"], ["pi-event-reducer", "session-store"],
  ["draft-store", "limits"], ["image-downscale", "limits"],
];

const d3Html = `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; height: 100%; font: 12px/1.3 -apple-system, system-ui, sans-serif; color: #1e293b; background: #fbf7ec; overflow: hidden; }
  svg { width: 100%; height: 100%; display: block; }
  .link { stroke: #94a3b8; stroke-opacity: 0.45; }
  .node circle { stroke: rgba(15,23,42,0.18); stroke-width: 1.2px; cursor: grab; }
  .node circle:active { cursor: grabbing; }
  .node text { font-size: 10px; fill: #0f172a; paint-order: stroke; stroke: rgba(251,247,236,0.85); stroke-width: 3px; pointer-events: none; }
  .legend { position: absolute; top: 8px; left: 10px; right: 10px; display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 10px; color: #475569; }
  .legend .sw { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 4px; vertical-align: middle; }
  .title { position: absolute; bottom: 6px; right: 10px; font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
</style></head><body>
  <div class="legend" id="legend"></div>
  <svg viewBox="0 0 600 360" preserveAspectRatio="xMidYMid meet"></svg>
  <div class="title">src/web · import graph</div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
  <script>
    const nodes = ${JSON.stringify(graphNodes)};
    const links = ${JSON.stringify(graphLinks.map(([source, target]) => ({ source, target })))};
    const groups = ["entry", "ui", "net", "state", "utils", "shared"];
    const palette = { entry: "#7c5cff", ui: "#06b6d4", net: "#f59e0b", state: "#22c55e", utils: "#ef4444", shared: "#64748b" };
    const radiusByGroup = { entry: 9, ui: 7.5, net: 6.5, state: 6, utils: 5.5, shared: 5 };

    const legend = document.getElementById("legend");
    for (const g of groups) {
      const span = document.createElement("span");
      span.innerHTML = '<span class="sw" style="background:' + palette[g] + '"></span>' + g;
      legend.appendChild(span);
    }

    const svg = d3.select("svg");
    const W = 600, H = 360;

    const link = svg.append("g").attr("class", "links").selectAll("line")
      .data(links).join("line").attr("class", "link").attr("stroke-width", 1);

    const node = svg.append("g").attr("class", "nodes").selectAll("g")
      .data(nodes).join("g").attr("class", "node")
      .call(d3.drag()
        .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on("end",   (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    node.append("circle")
      .attr("r", d => radiusByGroup[d.group] || 5)
      .attr("fill", d => palette[d.group] || "#64748b");

    node.append("text")
      .attr("dx", d => (radiusByGroup[d.group] || 5) + 3)
      .attr("dy", "0.32em")
      .text(d => d.id);

    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(d => 38).strength(0.55))
      .force("charge", d3.forceManyBody().strength(-160))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide().radius(d => (radiusByGroup[d.group] || 5) + 18).strength(0.9))
      .force("x", d3.forceX(W / 2).strength(0.06))
      .force("y", d3.forceY(H / 2).strength(0.07));

    sim.on("tick", () => {
      link
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => 'translate(' + d.x + ',' + d.y + ')');
    });

    // Settle quickly for screenshots; let users still drag.
    for (let i = 0; i < 220; i++) sim.tick();
    sim.alphaTarget(0).restart();

    // postMessage bridge so the parent recorder (which can't access this
    // sandboxed iframe's DOM) can query node positions and target real nodes
    // when scripting drag interactions for the promo GIF.
    window.addEventListener("message", (event) => {
      if (!event.data || typeof event.data !== "object") return;
      if (event.data.type === "getNodes" && event.source && typeof event.source.postMessage === "function") {
        event.source.postMessage({
          type: "nodes",
          viewBox: { w: W, h: H },
          payload: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, r: radiusByGroup[n.group] || 5 })),
        }, "*");
      }
    });

    // Signal painted state to host (Playwright waits on this attribute).
    window.addEventListener("load", () => document.body.setAttribute("data-d3-ready", "1"));
    document.body.setAttribute("data-d3-ready", "1");
  </script>
</body></html>`;

await writeSession({
  order: 5,
  id: "promo-d3-graph",
  name: "Module map",
  messages: [
    { role: "user", content: "Map the import graph of src/web so I can see how the UI, state, network and shared utility layers actually connect. Render it interactively.", timestamp: 1700000040100 },
    { role: "assistant", content: "Walked the AST, grouped modules by directory, and rendered a force-directed graph with D3 inside an HTML artifact. Drag a node to pull it; the layout snaps back.", timestamp: 1700000040200 },
    {
      role: "custom",
      content: "Module dependency graph — src/web (20 modules, 28 edges)",
      timestamp: 1700000040300,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: "promo-d3-graph-group",
        caption: "Module dependency graph · src/web · 20 modules, 28 edges",
        artifacts: [
          { mime: "text/html", html: d3Html, height: 360 },
          { mime: "text/plain", text: "Force-directed dependency graph rendered with D3 v7." },
        ],
      },
    },
    { role: "assistant", content: "Three structural notes from the layout: (1) `SessionDashboard` is the hub for everything UI — worth keeping thin. (2) `http-session-api` and `telemetry` have a small cycle; if telemetry becomes critical we should break that. (3) `markdown` is a leaf only used by `MessageTimeline`; safe to keep tightly scoped.", timestamp: 1700000040400 },
  ],
});

// ───────────────────────────────────────────────────────────────────────
// Session 6: Markdown artifact (inception — the markdown is itself the pitch)
// ───────────────────────────────────────────────────────────────────────

const inceptionMarkdown = `# Why pi-remote-control? 👋

You are reading this **inside the agent's reply**, on your phone, rendered
from a \`show_artifact\` tool call. No screen share. No copy-paste.

## What you get
- **Mobile-first WUI** — drive long-lived \`pi\` sessions from any browser
- **Rich artifacts inline** — Markdown, images, Vega-Lite, D3, HTML, JSON, tables
- **Detached workers** — close the laptop, keep the session; reconnect from your phone
- **Tailscale-friendly** — self-hosted, private, no third-party cloud

## A tiny table
| Feature          | Terminal | pi-remote-control |
|------------------|:--------:|:-----------------:|
| Inline charts    |    ❌    |        ✅         |
| Drag a D3 graph  |    ❌    |        ✅         |
| Works on iPhone  |    ❌    |        ✅         |
`;

await writeSession({
  order: 6,
  id: "promo-markdown-pitch",
  name: "Why pi-remote-control?",
  messages: [
    { role: "user", content: "Make me a quick one-pager I can show a teammate explaining why I'd install pi-remote-control.", timestamp: 1700000050100 },
    { role: "assistant", content: "Easiest way is to just render it as a markdown artifact — that way they see exactly the kind of rich output the WUI gives you.", timestamp: 1700000050200 },
    {
      role: "custom",
      content: "Why pi-remote-control?",
      timestamp: 1700000050300,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: "promo-markdown-pitch-group",
        caption: "Why pi-remote-control?",
        artifacts: [
          { mime: "text/markdown", text: inceptionMarkdown },
          { mime: "text/plain", text: inceptionMarkdown },
        ],
      },
    },
    { role: "assistant", content: "Inception complete — the markdown above was rendered inline by `show_artifact`. That's the whole pitch.", timestamp: 1700000050400 },
  ],
});

// ───────────────────────────────────────────────────────────────────────
// Session 7: Showcase tour. One session, multiple artifact kinds stacked so
// the promo GIF can scroll through them: markdown pitch → always-animating
// D3 waveform → seaborn statistical figure (image) → interactive widget with
// click-targetable controls. Used by scripts/record-showcase-gif.mjs.
// ───────────────────────────────────────────────────────────────────────

// Always-running D3 animation: three streaming sparklines + pulsing dots.
// Uses requestAnimationFrame so it visibly "plays" the whole time the
// recorder is parked on it.
const d3StreamHtml = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html, body { margin: 0; padding: 12px 14px; height: 100%; box-sizing: border-box; background: #fbf7ec; font: 12px/1.3 -apple-system, system-ui, sans-serif; color: #0f172a; }
  h2 { margin: 0 0 8px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #475569; }
  .row { display: grid; grid-template-columns: 90px 1fr 70px; gap: 8px 12px; align-items: center; margin-bottom: 6px; }
  .label { font-weight: 600; color: #1e293b; }
  .value { font-feature-settings: "tnum"; text-align: right; color: #0f172a; }
  svg { width: 100%; height: 38px; display: block; background: white; border-radius: 6px; box-shadow: inset 0 0 0 1px rgba(15,23,42,0.06); }
  .stat { stroke-width: 1.6; fill: none; }
  .stat-fill { opacity: 0.18; stroke: none; }
  .pulse { stroke: rgba(15,23,42,0.22); stroke-width: 1; }
</style></head><body>
<h2>Live service metrics · streaming</h2>
<div class="row">
  <span class="label" style="color:#7c5cff">qps</span>
  <svg id="chart-qps" viewBox="0 0 240 38" preserveAspectRatio="none"></svg>
  <span class="value" id="val-qps">—</span>
</div>
<div class="row">
  <span class="label" style="color:#06b6d4">p99 ms</span>
  <svg id="chart-p99" viewBox="0 0 240 38" preserveAspectRatio="none"></svg>
  <span class="value" id="val-p99">—</span>
</div>
<div class="row">
  <span class="label" style="color:#22c55e">cpu %</span>
  <svg id="chart-cpu" viewBox="0 0 240 38" preserveAspectRatio="none"></svg>
  <span class="value" id="val-cpu">—</span>
</div>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script>
  const W = 240, H = 38, N = 60;
  const series = {
    qps:  { color: "#7c5cff", base: 820, spread: 40, data: [], fmt: v => v.toFixed(0) },
    p99:  { color: "#06b6d4", base: 170, spread: 25, data: [], fmt: v => v.toFixed(0) + "ms" },
    cpu:  { color: "#22c55e", base: 0.52, spread: 0.07, data: [], fmt: v => (v*100).toFixed(1) + "%" },
  };
  for (const [k, s] of Object.entries(series)) {
    for (let i = 0; i < N; i++) s.data.push(s.base + (Math.sin(i * 0.3) + Math.cos(i * 0.5)) * s.spread * 0.5);
    const svg = d3.select("#chart-" + k);
    s.line = d3.line().x((_, i) => (i / (N - 1)) * W).y(v => H - 2 - ((v - (s.base - s.spread*1.8)) / (s.spread*3.6)) * (H - 4)).curve(d3.curveMonotoneX);
    s.area = d3.area().x((_, i) => (i / (N - 1)) * W).y0(H).y1(v => H - 2 - ((v - (s.base - s.spread*1.8)) / (s.spread*3.6)) * (H - 4)).curve(d3.curveMonotoneX);
    s.pathArea = svg.append("path").attr("class", "stat-fill").attr("fill", s.color);
    s.pathLine = svg.append("path").attr("class", "stat").attr("stroke", s.color);
    s.dot = svg.append("circle").attr("r", 2.6).attr("fill", s.color);
    s.ring = svg.append("circle").attr("r", 2.6).attr("class", "pulse").attr("fill", "none").attr("stroke", s.color);
  }
  let t = 0;
  function tick() {
    t += 1;
    for (const [k, s] of Object.entries(series)) {
      const noise = (Math.random() - 0.5) * s.spread * 0.55;
      const drift = Math.sin(t * 0.05 + (k === "p99" ? 1.4 : k === "cpu" ? 2.8 : 0)) * s.spread * 0.6;
      const next = s.base + drift + noise;
      s.data.push(next); if (s.data.length > N) s.data.shift();
      s.pathLine.datum(s.data).attr("d", s.line);
      s.pathArea.datum(s.data).attr("d", s.area);
      const lastY = (() => { const arr = s.line(s.data); return null; })();
      const lx = W, ly = H - 2 - ((next - (s.base - s.spread*1.8)) / (s.spread*3.6)) * (H - 4);
      s.dot.attr("cx", lx).attr("cy", ly);
      const pulse = (t % 30) / 30;
      s.ring.attr("cx", lx).attr("cy", ly).attr("r", 2.6 + pulse * 7).attr("opacity", 1 - pulse);
      document.getElementById("val-" + k).textContent = s.fmt(next);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  document.body.setAttribute("data-d3-stream-ready", "1");
<\/script></body></html>`;

// Interactive widget: signal generator with click-targetable buttons +
// sliders. The recorder will press Play, swap waveform type, etc. Buttons
// expose data-control IDs so the host can postMessage(getControls) to learn
// their iframe-relative positions and aim real mouse clicks at them.
const widgetHtml = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 14px 16px; height: 100%; box-sizing: border-box; background: #fbf7ec; font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #0f172a; }
  h2 { margin: 0 0 10px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #475569; }
  .wrap { display: grid; grid-template-rows: auto auto 1fr auto; gap: 10px; height: 100%; }
  canvas { width: 100%; height: 100%; display: block; background: #0f172a; border-radius: 10px; box-shadow: inset 0 0 0 1px rgba(15,23,42,0.2); }
  .group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .group .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-right: 4px; }
  button { font: inherit; font-size: 12px; padding: 6px 10px; border: 1px solid #cbd5e1; background: white; color: #0f172a; border-radius: 999px; cursor: pointer; transition: background 80ms, color 80ms, border-color 80ms; }
  button:hover { border-color: #7c5cff; }
  button.active { background: #7c5cff; color: white; border-color: #7c5cff; }
  button.play { background: #22c55e; color: white; border-color: #22c55e; min-width: 80px; }
  button.play.paused { background: white; color: #0f172a; border-color: #cbd5e1; }
  .slider { display: flex; align-items: center; gap: 6px; }
  input[type=range] { accent-color: #7c5cff; }
  .readout { font-feature-settings: "tnum"; color: #475569; min-width: 56px; text-align: right; }
</style></head><body>
<div class="wrap">
  <h2>Signal generator · interactive widget</h2>
  <div class="group">
    <span class="lbl">wave</span>
    <button data-control="wave-sine"     class="wave active">sine</button>
    <button data-control="wave-square"   class="wave">square</button>
    <button data-control="wave-saw"      class="wave">saw</button>
    <button data-control="wave-noise"    class="wave">noise</button>
    <button data-control="playpause" class="play">Pause</button>
  </div>
  <canvas id="scope" width="800" height="260"></canvas>
  <div class="group">
    <span class="lbl">freq</span>
    <div class="slider">
      <input data-control="freq" id="freq" type="range" min="1" max="20" step="1" value="4" />
      <span id="freq-out" class="readout">4 Hz</span>
    </div>
    <span class="lbl" style="margin-left:14px">amp</span>
    <div class="slider">
      <input data-control="amp" id="amp" type="range" min="10" max="100" step="5" value="70" />
      <span id="amp-out" class="readout">0.70</span>
    </div>
  </div>
</div>
<script>
  const canvas = document.getElementById("scope");
  const ctx = canvas.getContext("2d");
  function fit() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", fit); fit();

  let wave = "sine";
  let playing = true;
  let freq = 4, amp = 0.70;
  let t = 0;

  function sample(x) {
    const phase = x * freq * Math.PI * 2 + t;
    if (wave === "sine")   return Math.sin(phase) * amp;
    if (wave === "square") return Math.sign(Math.sin(phase)) * amp * 0.95;
    if (wave === "saw")    return ((((phase / Math.PI) % 2) + 2) % 2 - 1) * amp;
    return (Math.random() * 2 - 1) * amp;
  }

  function draw() {
    const r = canvas.getBoundingClientRect();
    const W = r.width, H = r.height;
    ctx.fillStyle = "#0f172a"; ctx.fillRect(0, 0, W, H);
    // grid
    ctx.strokeStyle = "rgba(148,163,184,0.18)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) { const y = i / 8 * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (let i = 0; i <= 12; i++) { const x = i / 12 * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    // baseline
    ctx.strokeStyle = "rgba(148,163,184,0.5)"; ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
    // waveform
    ctx.lineWidth = 2.4;
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "#7c5cff"); grad.addColorStop(0.5, "#06b6d4"); grad.addColorStop(1, "#22c55e");
    ctx.strokeStyle = grad;
    ctx.beginPath();
    const steps = 480;
    for (let i = 0; i <= steps; i++) {
      const x = i / steps * W;
      const v = sample(i / steps);
      const y = H/2 - v * (H/2 - 8);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function loop() {
    if (playing) { t += 0.06; }
    draw();
    requestAnimationFrame(loop);
  }
  loop();

  function setWave(w) {
    wave = w;
    document.querySelectorAll("button.wave").forEach((b) => b.classList.toggle("active", b.dataset.control === "wave-" + w));
  }
  document.querySelectorAll("button.wave").forEach((b) => b.addEventListener("click", () => setWave(b.dataset.control.replace("wave-", ""))));

  const pp = document.querySelector('[data-control="playpause"]');
  pp.addEventListener("click", () => {
    playing = !playing;
    pp.textContent = playing ? "Pause" : "Play";
    pp.classList.toggle("paused", !playing);
  });

  const freqEl = document.getElementById("freq"); const freqOut = document.getElementById("freq-out");
  freqEl.addEventListener("input", () => { freq = +freqEl.value; freqOut.textContent = freq + " Hz"; });
  const ampEl = document.getElementById("amp"); const ampOut = document.getElementById("amp-out");
  ampEl.addEventListener("input", () => { amp = +ampEl.value / 100; ampOut.textContent = amp.toFixed(2); });

  // postMessage bridge: parent recorder asks for control positions; we reply
  // with each control's bounding rect in iframe-local coords. Parent maps
  // them to screen coords and clicks them with real OS mouse events.
  window.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "getControls" || !event.source) return;
    const out = [];
    document.querySelectorAll("[data-control]").forEach((el) => {
      const r = el.getBoundingClientRect();
      out.push({ id: el.dataset.control, x: r.x, y: r.y, w: r.width, h: r.height });
    });
    event.source.postMessage({ type: "controls", payload: out }, "*");
  });

  document.body.setAttribute("data-widget-ready", "1");
<\/script></body></html>`;

const seabornDataUrl = await loadAsDataUrl(
  "promo-screenshots/static/seaborn-latency.png",
  "image/png",
);

await writeSession({
  order: 7,
  id: "promo-showcase-tour",
  name: "Showcase tour",
  messages: [
    { role: "user", content: "Give me a quick guided tour of what the WUI can render — markdown, a live D3 animation, a real statistical plot, and an interactive widget. Stack them in one session so I can scroll through.", timestamp: 1700000060100 },
    { role: "assistant", content: "Coming up — four artifacts in this conversation, one of each kind.", timestamp: 1700000060200 },
    {
      role: "custom",
      content: "Why pi-remote-control?",
      timestamp: 1700000060300,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: "tour-md-group",
        caption: "Why pi-remote-control?",
        artifacts: [
          { mime: "text/markdown", text: inceptionMarkdown },
          { mime: "text/plain", text: inceptionMarkdown },
        ],
      },
    },
    { role: "assistant", content: "Now a live D3 animation — three streaming sparklines updating every frame:", timestamp: 1700000060400 },
    {
      role: "custom",
      content: "Live service metrics · streaming D3",
      timestamp: 1700000060500,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: "tour-d3-group",
        caption: "Live service metrics · streaming sparklines (D3 v7, requestAnimationFrame)",
        artifacts: [
          { mime: "text/html", html: d3StreamHtml, height: 200 },
          { mime: "text/plain", text: "Streaming D3 sparklines." },
        ],
      },
    },
    { role: "assistant", content: "Next, a proper statistical figure — generated server-side with seaborn (violin + regression + correlation heatmap + KDE) and returned as a PNG artifact:", timestamp: 1700000060600 },
    {
      role: "custom",
      content: "Seaborn latency posthoc",
      timestamp: 1700000060700,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: "tour-seaborn-group",
        caption: "Service-latency posthoc · seaborn (violin + regression + corr heatmap + KDE)",
        artifacts: [
          { mime: "image/png", src: { kind: "url", url: seabornDataUrl }, alt: "Seaborn statistical figure with violin plot, regression scatter, correlation heatmap, and KDE" },
          { mime: "text/plain", text: "Seaborn statistical figure (PNG)." },
        ],
      },
    },
    { role: "assistant", content: "And finally an interactive widget — a real signal generator with clickable controls. Try Sine / Square / Saw, and the sliders:", timestamp: 1700000060800 },
    {
      role: "custom",
      content: "Signal generator widget",
      timestamp: 1700000060900,
      customType: "artifact",
      details: {
        version: 1,
        artifactGroupId: "tour-widget-group",
        caption: "Signal generator · click the waveform buttons to swap mode",
        artifacts: [
          { mime: "text/html", html: widgetHtml, height: 380 },
          { mime: "text/plain", text: "Interactive signal generator widget." },
        ],
      },
    },
    { role: "assistant", content: "End of tour — one session, four artifact kinds, all rendered inline. Same `show_artifact` extension all the way down.", timestamp: 1700000061000 },
  ],
});

console.log("done seeding promo sessions");
