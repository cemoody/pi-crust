# pi-remote-control

Mobile-first, self-hosted web control plane for running many concurrent [Pi coding-agent](https://pi.dev/) sessions from a browser, intended for private remote access over Tailscale.

See [`plan.md`](./plan.md) for the implementation roadmap.

## Development

```bash
npm install
npm run typecheck
npm test
npm run e2e
npm run check
```

### API adapter selection

The HTTP API defaults to the in-process Pi SDK adapter. For development without model/API access, keep using the mock adapter:

```bash
PI_REMOTE_USE_MOCK=1 npm run dev:api
```

To run hot sessions through Pi's JSONL RPC protocol instead, use the `pirpc` adapter:

```bash
PI_REMOTE_ADAPTER=pirpc npm run dev:api
```

The `pirpc` adapter starts one `pi --mode rpc` subprocess per hot session and forwards Pi RPC streaming events to the web UI over the existing SSE endpoint. Assistant text/thinking deltas, tool lifecycle updates, and final tool results continue to stream while the prompt HTTP request is in flight. It also loads the bundled `show_artifact` extension so the agent can return structured `piRemoteControlArtifact` tool results for browser rendering; HTML artifacts are rendered in a sandboxed iframe.

Pi RPC extension UI requests (`confirm`, `select`, `input`, `editor`, notifications, statuses, and widgets) are surfaced in the WUI over SSE. Dialog responses are posted back through `/api/sessions/:sessionId/extension-ui-response` and forwarded to the RPC subprocess as `extension_ui_response` messages.

Manual smoke check:

```bash
PI_REMOTE_ADAPTER=pirpc npm run dev:api
npm run dev
```

Then verify that a real session streams assistant text, streams tool output, renders a `show_artifact` result, and can answer an extension confirmation dialog. Pi RPC workers run as detached supervisor processes (see `scripts/pirpc-supervisor.mjs`) under `${XDG_RUNTIME_DIR:-/tmp/pi-remote-control}/sessions/`, so `kill <api-pid>` followed by `npm run dev:api` leaves every live session alive: the new API process reattaches automatically and replays any events that arrived while it was down (over SSE via `id:` / `Last-Event-ID`).

## Current status

Phase 0 project skeleton is being established first. Later phases will add the Pi SDK adapter, session registry, WebSocket protocol, and web UI.
