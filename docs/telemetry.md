# Telemetry & diagnostics

pi-crust writes one JSON line per relevant client/server event to
`logs/client-events.jsonl` (overridable via `PI_CRUST_CLIENT_EVENT_LOG`).
Everything stays on disk on the machine running the server — nothing is
sent anywhere.

## Event types

| event | source | when it fires |
|---|---|---|
| `boot` | browser | initial page load |
| `visibilitychange` | browser | tab focus / blur |
| `pagehide` / `pageshow` | browser | iOS-style suspension cycles |
| `beforeunload` | browser | tab/page closing |
| `window-error` | browser | uncaught JS error |
| `unhandledrejection` | browser | unhandled promise rejection |
| `sse-open` / `sse-close` | server | EventSource lifecycle on the API side |
| `sse-client-open` / `sse-client-error` / `sse-client-close` | browser | EventSource lifecycle on the client side |

Each entry carries:

- `lifetimeMs` / `ageMs` for the relevant timer
- A stable `tabSessionId` so events from the same tab can be grouped

## Why it exists

Originally added because iOS Safari + Vite HMR was causing spurious page
reloads on mobile that nuked composer drafts and scroll position. The
`pagehide` / `pageshow` / `sse-client-*` events were enough to
correlate the reloads to background-tab transitions and pin the bug to
HMR's auto-reload. Fix shipped in `src/web/utils/hmr-tame.ts`; HMR is
off by default on mobile.

## Disabling

Either point the log somewhere harmless:

```bash
PI_CRUST_CLIENT_EVENT_LOG=/dev/null npx pi-crust-full
```

Or delete it periodically — there's no rotation, the file grows
linearly with usage.
