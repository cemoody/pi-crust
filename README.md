<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img src="docs/assets/logo-light.svg" width="120" alt="π crust logo">
  </picture>
  <br>
  π crust
</h1>

<p align="center">
  <strong>Drive your <a href="https://pi.dev/">pi.dev</a> coding agent from your phone, edit its harness while it runs, and watch it render plots and dashboards inline next to its messages.</strong>
</p>

<p align="center">
  <a href="#-quick-start"><strong>Quickstart</strong></a> ·
  <a href="#-bundled-extensions"><strong>Extensions</strong></a> ·
  <a href="#-how-it-works"><strong>Architecture</strong></a> ·
  <a href="#-privacy--data-handling"><strong>Privacy</strong></a> ·
  <a href="https://github.com/cemoody/pi-crust/discussions"><strong>Discussions</strong></a> ·
  <a href="https://github.com/cemoody/pi-crust/issues"><strong>Issues</strong></a>
</p>

<p align="center">
  <img src="promo-screenshots/animations/iphone-d3-drag.gif" alt="Dragging nodes around an interactive D3 module graph live on iPhone" width="270" />
  &nbsp;
  <img src="promo-screenshots/iphone-14/03-vega-lite-artifact.png" alt="Vega-Lite chart artifact rendered inline on iPhone" width="270" />
</p>

<p align="center">
  <a href="https://pi.dev/"><img alt="Built for pi.dev" src="https://img.shields.io/badge/built%20for-pi.dev-7c3aed.svg"></a>
  <img alt="Mobile-first, desktop-friendly" src="https://img.shields.io/badge/mobile--first-%2B%20desktop--friendly-ff69b4.svg">
  <img alt="Self-modifying" src="https://img.shields.io/badge/self--modifying-live%20HMR-9c27b0.svg">
  <img alt="4 bundled extensions" src="https://img.shields.io/badge/extensions-4%20bundled-2ea44f.svg">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-3c873a.svg">
  <a href="LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-yellow.svg"></a>
</p>

## What is π crust?

pi-crust is a self-hosted web interface for the [pi.dev](https://pi.dev/) coding agent. Run pi sessions on your workstation, then drive them from your phone over Tailscale — long-running jobs survive your laptop closing, and the agent can render plots, dashboards, and HTML reports inline next to its messages instead of dumping paths to files in a terminal.

Three things make it different from running `pi` in a terminal:

- 📱 **Mobile-first, desktop-friendly.** One layout, no "mobile site" vs "desktop site" — runs the same on a phone over Tailscale and on a 32" monitor.
- 🔁 **Self-modifying.** Edit pi-crust's own source while it's running; changes propagate to the server and every connected browser in ~1 s without killing your chat session.
- 🧩 **Four bundled extensions.** Inline rich artifacts (`show_artifact`), slide decks (`show_presentation`), session fork/clone, cron-scheduled prompts — plus `spawn_prc_session` for parallel agent runs.

## 🚀 Quick start

```bash
npx pi-crust-full
```

Open `http://localhost:8787/`. Done.

> [!NOTE]
> Single-user beta. Sessions survive API restarts and the schema is stable, but multi-user auth and public-internet hardening are not done. Run it on your tailnet.

---

## 📱 Mobile-first, desktop-friendly

**On the phone:**

- 16-px composer inputs so iOS doesn't focus-zoom you out of the conversation.
- Paste-to-attach images, with automatic downscale so providers don't reject them.
- Compact mobile status bar; overflow-safe code / URL / inline-code rendering.
- Vite HMR is suppressed on mobile by default ([`hmr-tame.ts`](src/web/utils/hmr-tame.ts)) so an iOS tab resume doesn't `location.reload()` your scroll position into oblivion.
- SSE catches up via `Last-Event-ID` on resume — close the tab, reopen, no lost messages.
- Set `PI_CRUST_API_HOST=0.0.0.0` to reach it at `http://<machine>.<tailnet>.ts.net:8787/` from any device.

**On the desktop:**

- Multi-session sidebar with search, status dots, and filters.
- Wide artifact canvas for sandboxed-iframe HTML, Plotly, and force-directed graphs.
- Slash commands (`/fork`, `/clone`, …) and drag-and-drop attachment.
- One React tree fluidly reflows from 320 px to ultrawide. Layout regressions across viewports are pinned by Playwright in [`playwright.config.ts`](./playwright.config.ts).

---

## 🔁 Self-modifying

A `pi` session running *inside* pi-crust can edit pi-crust's own source and see the change reflected in the running server and browser within ~1 s, without losing the chat session.

| edit | how it propagates |
|---|---|
| `src/web/**/*.{ts,tsx,css}` | Vite HMR patches modules in every connected browser. Scroll, composer drafts, React state survive. No reload. |
| `src/server/**/*.ts` | [`scripts/dev-api.mjs`](scripts/dev-api.mjs) watches with a 500 ms debounce → SIGTERMs the API → the API **detaches** its `pi --mode rpc` workers (they keep running on UNIX sockets) → respawns → `reattachAll()`s. Your chat survives; the SSE stream blips for ~300 ms and reconnects via `Last-Event-ID`. |
| `vite.config.ts` | An in-config plugin exits Vite on change; the outer `dev:web:loop` restarts in <1 s with the new config. |
| `git pull` from another machine | Indistinguishable from "agent edited a file" — the same file watchers fire. |

Active-session safety is pinned by [`tests/e2e/api-restart-resume.test.ts`](tests/e2e/api-restart-resume.test.ts): restart the API mid-stream and assert the final message matches a no-restart control run.

The API server and the `pi` workers are separate processes. The API is the cheap, restartable layer; the workers hold the real agent state on UNIX sockets under `/tmp/pi-crust-$UID/`. That's what lets you restart the API without losing the agents, and restart the browser without losing the stream.

---

## 🧩 Bundled extensions

pi-crust ships four built-in extensions that the agent can call as tools, plus auto-loads [`@cemoody/pi-artifact`](https://github.com/cemoody/pi-artifact) when present.

| extension | tools / features | what the agent can do |
|---|---|---|
| **`core.artifacts`** | `show_artifact` | Render `image`, `html` (sandboxed iframe), `vega-lite`, `markdown`, `json`, `table` inline in the conversation. |
| **`core.presentations`** | `show_presentation`, `list_presentation_templates` | Generate slide decks with brand template packs (e.g. `brainco`) — preview, present, download — from a tool call. |
| **`core.branching`** | `/fork`, `/clone` slash commands | Fork a session from any previous user message, or clone the whole conversation. |
| **`core.schedule`** | Cron UI + `/api/cron` endpoints | Schedule recurring prompts. **Run now** spawns and jumps into the live session. |
| `@cemoody/pi-artifact` *(optional, auto-loaded)* | `display()` | Multi-MIME inline artifacts — point at a PNG / HTML / Plotly figure / Vega-Lite spec and it renders. |
| Built-in | `spawn_prc_session` | Create another pi-crust session with its own `cwd`, name, and starting prompt. |

```ts
await tools.show_artifact({
  kind: "vega-lite",
  title: "Daily error budget",
  data: { /* Vega-Lite v5 spec */ },
});

await tools.spawn_prc_session({
  sessionName: "dependabot sweep",
  cwd: "/home/coder/myrepo",
  prompt: "Review every open dependabot PR and merge the safe ones.",
});
```

### Rich artifacts in action

<p align="center">
  <img src="promo-screenshots/animations/showcase-tour.gif" alt="One session containing a markdown report, a live D3 sparkline, a seaborn figure, and an interactive signal-generator widget" width="720" />
</p>

One session, four artifact kinds: a markdown pitch, a live D3 streaming sparkline, a seaborn statistical figure (violin + regression + KDE + correlation heatmap), and an interactive signal-generator widget — all rendered inline via `show_artifact`.

| kind | what the agent passes | renders as |
|---|---|---|
| `image` | `path` to png / jpeg / webp / gif | inline image, auto-downscaled |
| `html` | `path` or `html: "<html>…"` | sandboxed iframe — Plotly, D3, Three.js work |
| `vega-lite` | Vega-Lite v5 spec | auto re-themed chart |
| `markdown` | markdown string | rendered with code highlighting |
| `json` / `table` | structured data | built-in viewer with copy/download |

### Writing your own extension

A pi-crust extension is an `activate(ctx)` function referenced from `package.json`:

```json
{
  "name": "my-extension",
  "piRemoteControl": { "extension": "./server.mjs", "web": "./web.mjs" }
}
```

```js
// server.mjs
export default function activate(ctx) {
  ctx.server.api.get('/api/hello', async () => ({ ok: true }));
  ctx.commands.register({
    id: 'my.command',
    slashName: 'hello',
    run: async () => ({ prcAction: 'notice', notice: 'Hi!' }),
  });
}
```

The four bundled extensions under [`extensions/`](./extensions) are the worked examples: a static-file route ([`artifacts`](./extensions/artifacts)), slash commands ([`branching`](./extensions/branching)), template-pack discovery + dynamic API routes ([`presentations`](./extensions/presentations)), and an extension with its own UI panel ([`schedule`](./extensions/schedule)).

---

## 🔧 Install options

```bash
# Recommended — pi-crust + all official extensions (same as top of README)
npx pi-crust-full

# Lean — core only, no extensions meta-package
npx pi-crust

# Offline mock — no `pi` binary needed
PI_CRUST_USE_MOCK=1 npx pi-crust-full

# Share on the tailnet
PI_CRUST_API_HOST=0.0.0.0 npx pi-crust-full

# Self-edit dev loop — Vite HMR + tsx auto-restart, one process
npx -p pi-crust pi-crust-dev

# Install straight from GitHub main (unreleased)
npx -y -p github:cemoody/pi-crust pi-crust
```

### CLI commands

Once installed (via any of the options above), these commands are on your `PATH`:

| command | what it does |
|---|---|
| `pi-crust` | Boot the HTTP+SSE API server + serve the built UI from one process. Default port `8787`. |
| `pi-crust-dev` | Same, but in dev mode: Vite HMR for `src/web/**`, `tsx` auto-restart for `src/server/**`, active sessions survive via detach/reattach. Single process, one terminal. |
| `pi-crust install <pkg>` | Install a third-party pi-crust extension package into `~/.pi-crust/extensions/`. |
| `pi-crust remove <pkg>` | Uninstall a previously-installed extension package. |

Slash commands available inside any session (from the bundled extensions):

| slash command | what it does |
|---|---|
| `/fork [n\|text]` | Fork the session from a previous user message (interactive picker, or specify by index / substring). |
| `/clone` | Duplicate the entire current session into a new one. |

---

## 🧠 How it works

```
                    ┌───────────────────────────────────────┐
   iPhone / iPad ──▶│  vite UI  (read & steer)              │
   laptop browser   │  EventSource over Tailscale           │
                    │       │                               │
                    │       ▼                               │
                    │  HTTP API ◀──▶ session registry       │
                    │       │                               │
                    │       ▼                               │
                    │  pi-rpc supervisor procs              │
                    │   │     │     │     │                 │
                    │   ▼     ▼     ▼     ▼                 │
                    │  `pi --mode rpc` workers (detached)   │
                    │   one per live session                │
                    │       │                               │
                    │       └─ extensions ──▶ browser       │
                    │          (artifacts, presentations,   │
                    │           branching, schedule, …)     │
                    └───────────────────────────────────────┘
```

The API server and the `pi` workers are **separate processes**. The API is the cheap, restartable layer; the workers hold the real agent state on UNIX sockets under `/tmp/pi-crust-$UID/`. That separation is what lets you restart the API (or upgrade pi-crust) without losing detached agents, and restart the browser without losing the SSE stream.

### Stack

| layer | tech |
|---|---|
| Frontend | React 19 + Vite, native `EventSource` over SSE |
| API server | Node 22, native `http`, SSE streaming, no framework |
| Worker supervisor | Custom Node script spawning `pi --mode rpc` as detached subprocesses |
| Worker IPC | UNIX domain sockets under `/tmp/pi-crust-$UID/s/` |
| Storage | JSONL session files under `~/.pi/agent/sessions/`; cron jobs in `~/.pi/agent/cron-jobs.json` |
| Extensions | TypeScript-or-mjs `activate(ctx)` modules loaded from `extensions/` (bundled) and `~/.pi-crust/extensions/` (user-installed) |
| Tests | Vitest (unit) + Playwright (browser + npx integration) |

---

## 🔒 Privacy & data handling

pi-crust is **fully self-hosted**. Nothing about your code, sessions, or telemetry leaves the machine running the API.

- **Sessions** are JSONL files under `~/.pi/agent/sessions/` (override with `PI_CRUST_SESSION_ROOT`).
- **Worker IPC** is UNIX domain sockets in `/tmp/pi-crust-$UID/` — local-only, mode `0700`.
- **Browser ↔ API** is whatever transport you choose: localhost by default, Tailscale if you set `PI_CRUST_API_HOST=0.0.0.0`. pi-crust does not initiate any outbound calls of its own.
- **Telemetry** is local-only too. The client-events log (`logs/client-events.jsonl`) is written to disk on your machine and never sent anywhere. See [`docs/telemetry.md`](docs/telemetry.md).
- **LLM calls** go wherever the underlying `pi` agent is configured to send them (Anthropic, OpenAI, your own endpoint, etc.). pi-crust just brokers them.

If you want to expose pi-crust over the public internet rather than a tailnet, **don't** — the beta has no auth.

---

## ⚙️ Configuration

<details>
<summary><b>Environment variables</b></summary>

> **Renamed from `PI_REMOTE_*`** in May 2026. The old names still work as a fallback during the deprecation window (you'll see a one-time stderr warning on startup; set `PI_CRUST_SUPPRESS_RENAME_WARNING=1` to silence). Update your configs to `PI_CRUST_*`.

| variable | default | what it does |
|---|---|---|
| `PI_CRUST_API_PORT` | `8787` | HTTP+SSE API port |
| `PI_CRUST_API_HOST` | `127.0.0.1` | bind address (set `0.0.0.0` for tailnet) |
| `PI_CRUST_PROJECT_ROOT` | `$HOME` | path-policy root for new session `cwd` |
| `PI_CRUST_SESSION_ROOT` | `~/.pi/agent/sessions` | where session JSONL files live |
| `PI_CRUST_CRON_FILE` | `~/.pi/agent/cron-jobs.json` | cron job store |
| `PI_CRUST_CLIENT_EVENT_LOG` | `<cwd>/logs/client-events.jsonl` | client/server telemetry log |
| `PI_CRUST_APP_NAME` | `π crust` | sidebar / browser title (overridable in Settings) |
| `PI_CRUST_APP_ICON` | unset | title icon URL / data URL (overridable in Settings) |
| `PI_CRUST_ADAPTER` | `pirpc` | `pirpc` / `pi-sdk` / `mock` |
| `PI_CRUST_USE_MOCK` | unset | `1` selects the in-memory mock adapter |
| `PI_CRUST_DISABLE_CEMOODY_ARTIFACT` | unset | `1` to skip auto-loading `@cemoody/pi-artifact` |
| `PI_CRUST_CEMOODY_ARTIFACT_PATH` | unset | override path to a local checkout |
| `VITE_PI_CRUST_PROXY_TARGET` | `http://127.0.0.1:8787` | API target for the vite dev proxy |
| `VITE_PI_CRUST_HMR` | unset | `1` to re-enable Vite HMR (off by default on mobile) |

</details>

<details>
<summary><b>Adapters</b></summary>

- **`pirpc` (default).** Each session runs in a detached `pi --mode rpc` supervisor so live sessions survive API restarts. Auto-loads the bundled extensions and `@cemoody/pi-artifact` when installed.
- **`pi-sdk`.** In-process Pi SDK adapter — no subprocess, no detach.
- **`mock`** (`PI_CRUST_USE_MOCK=1`). Pure in-memory mock for offline dev, screenshots, and tests.

</details>

---

## 🛠 Development

```bash
git clone https://github.com/cemoody/pi-crust
cd pi-crust
npm install

# Terminal 1 — API supervisor (auto-restart on src/server/** edits)
npm run dev:api:loop

# Terminal 2 — Vite (HMR for src/web/**, auto-restart on vite.config.ts)
npm run dev:web:loop

# Terminal 3 (optional) — auto-pull origin/main every 15 s
npm run dev:git-puller
```

Open `http://localhost:5173/`.

### Tasks

```bash
npm run typecheck       # tsc --noEmit
npm test                # vitest (unit + e2e)
npm run e2e             # just e2e
npm run e2e:browser     # playwright mobile-layout regression
npm run promo           # regenerate README hero screenshots
npm run promo:gif       # record the interactive-D3 hero GIF (needs ffmpeg)
npm run check           # typecheck + tests + e2e
npm run build           # vite build of the UI bundle
```

---

## 📖 Further reading

- [`extensions/`](./extensions) — four worked extension examples
- [`docs/telemetry.md`](docs/telemetry.md) — client/server event log format
- [`docs/plans/`](docs/plans/) — design notes & implementation plans (SSE hardening, extension framework, slash-command UI, presentations…)
- [pi.dev coding agent docs](https://pi.dev/) — the upstream agent this wraps
- [`@cemoody/pi-artifact`](https://github.com/cemoody/pi-artifact) — companion `display()` extension

---

## 📄 License

MIT.
