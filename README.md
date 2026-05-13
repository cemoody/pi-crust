# pi-remote-control

A self-hosted, mobile-first **web remote control for the [pi.dev](https://pi.dev/)
coding agent**. Run long-lived `pi` sessions on a workstation, then drive them
from your phone, tablet, or any browser — typically over Tailscale on the
private network — without losing context when you close the laptop, hand off
to a phone, or restart the API server.

It comes with first-class support for **rich agent artifacts**: images,
self-contained HTML, Vega-Lite charts, markdown reports, JSON, and tables
that your agent can return from a tool call and have them rendered inline in
the conversation — no copy-paste, no screen-sharing.

```
                    ┌───────────────────────────────────────┐
   iPhone / iPad ──▶│  /  vite UI  (read & steer)           │
   laptop browser   │  /  EventSource over Tailscale        │
                    │  /                                    │
                    │  HTTP API ◀──▶ session registry       │
                    │      │              │                 │
                    │      │              ▼                 │
                    │      │     pi-rpc supervisor procs    │
                    │      │       │       │       │        │
                    │      ▼       ▼       ▼       ▼        │
                    │   `pi --mode rpc` workers (detached)  │
                    │   one per live session                │
                    │      │                                │
                    │      └─ show_artifact extension ──▶ WUI│
                    └───────────────────────────────────────┘
```

## Why this exists

The pi.dev coding agent is great in a terminal, but the moments you actually
want to look at it are scattered through the day — on the bus, at lunch, in
bed. This project gives `pi` a persistent, multi-session HTTP+SSE front end
so:

- You can kick off a long-running agent run from your laptop, then watch it
  finish from your phone over Tailscale.
- Long tool runs (CI watch, dependabot sweeps, build loops) don't end when
  you close the lid — the agent keeps going inside its `pi --mode rpc`
  worker, and you can reattach whenever.
- When the agent produces a plot, a generated image, an HTML report, or a
  table, it's rendered inline next to the message — not buried in a `cat`
  output.

## Highlights

- **Multi-session WUI.** Sidebar with search / filters / status dots; one
  active session pane on the right.
- **Mobile-first.** Compact mobile status bar, 16-px inputs (no iOS focus
  zoom), overflow-safe code / URL / inline-code rendering, paste-image
  attachment, automatic downscale of oversized images so providers don't
  reject them.
- **Pi RPC adapter with detached workers.** Each live session runs as a
  supervised `pi --mode rpc` subprocess under
  `${XDG_RUNTIME_DIR:-/tmp/pi-remote-control}/sessions/`. The API server
  can be killed and restarted (or upgraded) without losing live sessions —
  the new API process reattaches and replays missed events via SSE
  `Last-Event-ID`.
- **Streaming everything.** Assistant text, thinking, tool calls, tool
  output, message-end and tool-execution-end events all stream over SSE
  while the prompt HTTP request is in flight.
- **Rich artifacts (`show_artifact` extension).** The bundled
  `pi-remote-artifacts` extension registers a `show_artifact` tool the agent
  can call to render in the WUI:
  - `image` — png/jpeg/webp/gif by path
  - `html`  — self-contained HTML in a sandboxed iframe (perfect for
    Plotly, D3, Three.js, custom dashboards)
  - `vega-lite` — Vega-Lite v5 spec object; auto re-themed
  - `markdown` — rendered markdown reports
  - `json` / `table` — structured data with a built-in viewer
- **Extension UI prompts surfaced in the browser.** `confirm`, `select`,
  `input`, `editor`, statuses, notifications, and widget requests from `pi`
  RPC are forwarded to the WUI; the user's response is posted back to
  the worker.
- **Cron-scheduled prompts.** Create named jobs (cron expressions) that
  spawn a fresh `cron: <name>` session at the scheduled time, or fire one
  on demand with **Run now**. "Run now" is fire-and-forget — the HTTP
  request returns as soon as the session is spawned, so the WUI can
  immediately navigate into it and watch the agent work.
- **Browser-driven reload telemetry** (opt-in via `clientEventLogPath`).
  Logs page boots, visibility transitions, EventSource lifecycle, and
  unhandled errors to `logs/client-events.jsonl` so you can diagnose
  spurious refreshes on real devices.
- **HMR off by default** in this deploy. Reading on a phone over Tailscale
  and Vite's HMR client don't get along (iOS suspends background tabs,
  HMR sees stale WS, calls `location.reload()`, you lose your place). Set
  `VITE_PI_REMOTE_HMR=1` to opt back in locally.

## Quick start

```bash
git clone https://github.com/cemoody/pi-remote-control.git
cd pi-remote-control
npm install

# Terminal 1: HTTP+SSE API (pi RPC adapter by default; bundles the
# show_artifact extension automatically per session).
npm run dev:api

# Terminal 2: Vite dev server for the WUI.
npm run dev
```

Browse to `http://localhost:5173/`. On Tailscale, hit
`http://<tailnet-ip>:5173/?session=<session-id>` from any device on your
tailnet.

### Common env

| variable                          | default                                          | what it does |
|---|---|---|
| `PI_REMOTE_API_PORT`              | `8787`                                           | HTTP+SSE API port |
| `PI_REMOTE_API_HOST`              | `127.0.0.1`                                      | bind address |
| `PI_REMOTE_PROJECT_ROOT`          | `$HOME`                                          | path-policy root for `cwd` of new sessions |
| `PI_REMOTE_SESSION_ROOT`          | `~/.pi/agent/sessions`                           | where session JSONL files live |
| `PI_REMOTE_CRON_FILE`             | `~/.pi/agent/cron-jobs.json`                     | cron job store |
| `PI_REMOTE_CLIENT_EVENT_LOG`      | `<cwd>/logs/client-events.jsonl`                 | client/server telemetry log |
| `PI_REMOTE_ADAPTER`               | `pirpc`                                          | `pirpc` (default) / `pi-sdk` / `mock` (with `PI_REMOTE_USE_MOCK=1`) |
| `VITE_PI_REMOTE_PROXY_TARGET`     | `http://127.0.0.1:8787`                          | API target the vite dev proxy talks to |
| `VITE_PI_REMOTE_HMR`              | unset                                            | set to `1` to re-enable Vite HMR |

### Adapters

- **`pirpc` (default).** Runs each session in a detached `pi --mode rpc`
  supervisor process so live sessions survive API restarts. Loads the
  bundled `show_artifact` extension. Best for real use.
- **`pi-sdk`.** In-process Pi SDK adapter — no subprocess, no detach. Use
  when you don't need the supervisor.
- **`mock`** (`PI_REMOTE_USE_MOCK=1`). Pure in-memory mock for offline
  development, screenshots, and tests.

## Artifacts: the agent talks to the WUI

The bundled `show_artifact` tool gives the agent a way to render anything it
just produced. From an agent prompt or skill:

```ts
// inside the agent's tool flow
await tools.show_artifact({
  kind: "vega-lite",
  title: "Daily error budget",
  data: {                                  // a Vega-Lite v5 spec
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: [...] },
    mark: "line",
    encoding: { x: { field: "day", type: "temporal" }, y: { field: "p99", type: "quantitative" } },
  },
});
```

```ts
// or generate a Plotly dashboard offline, return it as HTML
await tools.show_artifact({
  kind: "html",
  title: "Cluster utilization",
  path: "/tmp/util-report.html",            // or pass `html: "<html>..."` inline
  mimeType: "text/html",
});
```

```ts
// or just point at an image you saved
await tools.show_artifact({
  kind: "image",
  title: "tSNE of embeddings",
  path: "out/tsne.png",
  alt: "2-D tSNE projection of 50k embedding vectors",
});
```

The WUI renders the artifact in the timeline as a card with a title, the
content, and a copy / download menu. HTML is rendered in a sandboxed iframe.

## Cron-scheduled prompts

Open the **Cron** tab in the sidebar, create a job (name, cron expression,
prompt, cwd, enabled), and the scheduler spawns a fresh
`cron: <name>` session at each tick. You can also click **Run now**
on any job — the API kicks off the session, returns immediately, and the
WUI navigates straight into the spawned session so you can watch it work.

## Resilience

- Sessions are JSONL files. Killing the API process does **not** kill the
  pi RPC worker; on the next `npm run dev:api` the API reattaches via the
  supervisor's UNIX socket and the WUI's SSE replays missed events from the
  last-seen seq.
- The Vite dev server can be killed and respawned (the included
  `prc-loop.sh` does this in a `while :;` loop along with a 15-s
  `git pull --ff-only origin main` puller, for "always-on-latest" deploys).
- Auto-puller + Vite HMR were a bad combination on mobile; HMR is off by
  default now (`vite.config.ts`).

## Development

```bash
npm install
npm run typecheck           # tsc --noEmit
npm test                    # vitest run (unit + e2e under tests/)
npm run e2e                 # just the e2e tests
npm run e2e:browser         # playwright (mobile screenshot suite)
npm run check               # typecheck + tests + e2e
npm run build               # vite build of the WUI
```

Manual smoke check for the pi RPC + artifacts path:

```bash
PI_REMOTE_ADAPTER=pirpc npm run dev:api
npm run dev
```

Then in the WUI:

1. Create a session.
2. Ask the agent something that streams text and runs a tool — verify the
   stream lands while the prompt request is still in flight.
3. Ask it to produce a `show_artifact` of each kind (image, html,
   vega-lite, markdown, json, table) — verify each renders.
4. Reply to an extension `confirm` / `select` / `input` prompt — verify it
   round-trips.
5. `kill <api-pid>` then `npm run dev:api` again — verify the live session
   reattaches and the SSE catches up to where it left off.

## Telemetry & diagnostics

`logs/client-events.jsonl` receives one JSON line per:

- `boot` — `navigationType`, `bootCount`, `tabSessionId`, `referrer`,
  `activeSessionId`, `userAgent`, `timeOrigin`
- `visibilitychange`, `pagehide` (with `persisted`), `pageshow`,
  `beforeunload`
- `window-error`, `unhandledrejection`
- `sse-open` / `sse-close` (server-side) with `lifetimeMs`
- `sse-client-open` / `sse-client-error` / `sse-client-close`
  (browser-side) with `ageMs`

That was enough to identify a spurious-reload bug as iOS Safari + Vite HMR
in PR #38 (which is also the reason HMR is off by default).

## Status

Production-friendly for "remote control over Tailscale" use. Schema and
protocol are stable enough that detached workers survive API restarts, but
this is still a single-user tool; expect rough edges around multi-user
permissions.

See [`plan.md`](./plan.md) for the implementation roadmap and
[`pirpc-streaming-sse-hardening-plan.md`](./pirpc-streaming-sse-hardening-plan.md)
for SSE replay / hardening notes.
