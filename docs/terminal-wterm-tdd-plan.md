# Browser terminal (wterm + PTY backend): TDD plan

Goal: add a **Terminal tab** to the active-session view that reveals a
[`wterm`](https://github.com/vercel-labs/wterm) DOM terminal, backed by a new
server-side **PTY session** streamed over the existing Socket.IO gateway. The
shell runs in the session's `cwd`, confined by the same `PathPolicy` the
session registry already enforces.

This document is the spec the test harness encodes, modeled on
`docs/realtime-socketio-contract.md`.

## Why wterm

wterm renders to the **DOM** (not canvas like xterm.js), so Playwright can use
native `getByText` / text selection on terminal output — assertions are real,
not screenshots. ~12KB WASM core. The tradeoff (it's young) is mitigated by the
test pyramid below: the server PTY layer is fully tested headless, independent
of the renderer.

## Status legend

- 🔴 **RED** = new surface; fails until implemented.
- 🟢 **GREEN** = invariant that must keep holding.

## Wire protocol (PTY over the Socket.IO gateway)

Reuses the one multiplexed socket per origin. New events alongside
`session:subscribe` / `session:event`:

### Client → server (with ack callback)

| event             | payload                                       | ack                                              |
| ----------------- | --------------------------------------------- | ------------------------------------------------ |
| `pty:open`        | `{ sessionId, cols, rows }`                   | `{ ok:true, ptyId }` or `{ ok:false, error }`    |
| `pty:input`       | `{ ptyId, data }`                             | `{ ok:true }`                                     |
| `pty:resize`      | `{ ptyId, cols, rows }`                       | `{ ok:true }`                                     |
| `pty:close`       | `{ ptyId }`                                   | `{ ok:true }`                                     |

### Server → client

| event        | payload                              |
| ------------ | ------------------------------------ |
| `pty:data`   | `{ ptyId, seq, data }` (stdout/stderr chunk) |
| `pty:exit`   | `{ ptyId, exitCode, signal }`        |

`data` chunks carry a monotonic `seq` per `ptyId` so loss/ordering is
assertable exactly like `session:event`.

## Test layers

| Layer | File | What it pins |
| ----- | ---- | ------------ |
| Unit — PTY manager | `tests/unit/pty-manager.test.ts` | spawn/lifecycle/buffer logic, headless, fake child |
| Unit — Terminal panel | `tests/unit/terminal-panel.test.tsx` | tab/panel React behavior with a fake transport |
| Integration — PTY + path policy | `tests/integration/pty-session.test.ts` | real `node-pty` child confined to cwd |
| E2E — PTY over gateway | `tests/e2e/pty-realtime-contract.test.ts` | real socket.io-client ↔ real server PTY |
| Playwright — headline | `tests/playwright/terminal-tab-wterm.spec.ts` | real Chromium: open tab → type bash → file created |
| Playwright — smoke | folded into `app-chrome-smoke.spec.ts` | tab mounts wterm, no console/page errors |

Shared harness: extend `tests/helpers/realtime-test-harness.ts` with
`openPty()` / `nextPtyData()` helpers (same queue-on-connect pattern that
avoids the EventEmitter drop race).

---

## 1. Unit — PTY manager (`tests/unit/pty-manager.test.ts`) 🔴

Pure logic over an injectable child-process factory (no real shell).

1. **opens a pty** → returns a unique `ptyId`; tracks it as live.
2. **forwards input** → bytes written to the panel reach the child's stdin
   verbatim (including control chars like `\u0003` Ctrl-C).
3. **streams output with monotonic seq** → child stdout chunks emit `pty:data`
   with `seq` `1,2,3…` per `ptyId`, never reordered.
4. **resize** → `resize(cols,rows)` calls the child's resize with clamped,
   positive integers; rejects `0`/negative/`NaN`.
5. **close is idempotent** → `close()` twice kills once, emits one `pty:exit`.
6. **exit propagation** → child exit emits `pty:exit` with the real
   `exitCode` + `signal`; the id is then unknown to `input`/`resize`.
7. **per-pty isolation** → two ptys keep independent seq counters and buffers;
   input to one never lands in the other.
8. **backpressure cap** → an unbounded-output child does not grow memory without
   bound (ring/byte cap), and the cap emits a `session_resync`-style marker
   rather than silently dropping.

## 2. Unit — Terminal panel (`tests/unit/terminal-panel.test.tsx`) 🔴

React panel against a `FakePtyTransport` (DOM-free transport seam, mirrors
`realtime-client-harness`).

9. **tab is present and labeled** → active-session view exposes a
   `role="tab"` named `Terminal` next to the existing chat view.
10. **lazy open** → no `pty:open` is sent until the Terminal tab is first
    activated (don't spawn a shell for sessions nobody opens a terminal on).
11. **renders streamed output** → `pty:data` chunks append to the wterm host;
    rendered text is queryable (DOM renderer ⇒ `getByText`).
12. **keystrokes → input** → typing in the focused terminal emits `pty:input`
    with the exact bytes.
13. **resize on container resize** → a ResizeObserver/fit change emits
    `pty:resize` with new cols/rows (debounced, deduped).
14. **exit shows a banner** → `pty:exit` renders a non-blocking
    "Process exited (code N)" affordance with a "Restart" control.
15. **teardown on tab switch / unmount** → leaving the tab (or unmount) emits
    `pty:close` exactly once; no leaked listeners.

## 3. Integration — PTY + path policy (`tests/integration/pty-session.test.ts`) 🔴

Real `node-pty` child, real `SessionRegistry`/`PathPolicy`, no browser.
Uses a tmp project root as the only allowed cwd.

16. **shell starts in session cwd** → `pwd\n` returns the session's resolved
    `cwd`.
17. **command side effects are real** → writing
    `echo SENTINEL > probe.txt\n` creates `<cwd>/probe.txt` on disk with the
    exact content; teardown removes it.
18. **cwd confinement** → a pty cannot be opened for a session whose cwd is
    outside `allowedProjectRoots` (rejected before spawn, mirrors
    `assertAllowedCwd`).
19. **exit code surfaces** → `exit 7\n` yields `pty:exit { exitCode: 7 }`.
20. **kill on session dispose** → disposing the session SIGKILLs any live pty;
    no orphaned child survives (assert via pid liveness).

## 4. E2E — PTY over the gateway (`tests/e2e/pty-realtime-contract.test.ts`) 🔴

Real `socket.io-client` against the real `createHttpApiServer`, mock/test
adapter. Same rigor as `socketio-realtime-contract.test.ts`.

21. **open → live output** → `pty:open` acks a `ptyId`; running `echo hi`
    streams `pty:data` containing `hi` while the socket stays connected.
22. **multiplexing** → two ptys (or pty + a chat `session:subscribe`) share ONE
    physical socket; zero cross-talk between `ptyId`s.
23. **ordered, lossless stream** → a sustained burst (`yes | head -n 2000`)
    delivers every chunk with monotonic `seq`, no gaps (the multitab
    zero-loss bar).
24. **unknown pty rejected via ack** → `pty:input` to a bogus `ptyId` acks
    `{ ok:false }`; socket stays connected.
25. **reconnect** → after a transport drop, the pty is closed and a fresh
    `pty:open` starts clean (PTYs are not resumable across sockets — assert the
    contract, don't pretend to replay a live shell).

## 5. Playwright — headline (`tests/playwright/terminal-tab-wterm.spec.ts`) 🔴

Real Chromium, real server (`PI_CRUST_USE_MOCK=1` + seeded session), the exact
scenario requested. wterm's DOM rendering makes every assertion real.

26. **open tab reveals wterm** → select seeded session → click
    `getByRole('tab', { name: 'Terminal' })` → the wterm host
    (`[data-testid="wterm-root"]`) is visible and the shell prompt renders.
27. **bash creates a file (the headline)**:
    ```
    type: echo pi-crust-e2e-${RUN_ID} > .tmp/wterm-probe-${RUN_ID}.txt ⏎
    → poll for command completion (prompt re-renders)
    → assert the file exists on disk with exact sentinel content
    → cleanup the probe file
    ```
    File check runs in a Playwright fixture/`globalTeardown` with fs access to
    the seed cwd (it owns `.tmp/playwright-sessions`), OR via a read-only
    `GET /api/sessions/:id/fs/exists?path=…` guarded by `PathPolicy`. Prefer the
    fixture (no new HTTP surface to secure).
28. **output is selectable text** → the typed command and its echo are
    present via `getByText` (proves DOM renderer, not canvas).
29. **resize survives a viewport change** → shrink the viewport; terminal stays
    usable and a follow-up command still runs (cols/rows re-fit).
30. **no console / page errors** → track `pageerror` + `console` (minus the
    known benign `client-event` 502), assert empty — same gate as
    `socketio-multitab.spec.ts`.

## Invariants (🟢 GREEN — must not regress)

- The Socket.IO `session:event` contract (all of `socketio-realtime-contract`)
  stays green after PTY events share the socket.
- REST stays REST; `/socket.io/` does not shadow `/api/*`.
- No pty is spawned for sessions whose Terminal tab is never opened.
- `PathPolicy` allow-lists remain the single source of cwd truth — the terminal
  adds **no** new path-escape surface.
- A disposed/cooled session leaves **no** orphaned shell process.

## Out of scope (later)

- Persisting/replaying a live shell across socket reconnects (PTYs are
  ephemeral by contract item 25).
- Multiple concurrent terminals per session tab (single pty per Terminal tab
  for v1).
- Mobile terminal ergonomics (soft-keyboard, paste) — its own Playwright suite.

## Run

```bash
# new surface (expect RED until implemented):
npx vitest run tests/unit/pty-manager.test.ts \
               tests/unit/terminal-panel.test.tsx \
               tests/integration/pty-session.test.ts \
               tests/e2e/pty-realtime-contract.test.ts
npx playwright test tests/playwright/terminal-tab-wterm.spec.ts

# invariants (expect GREEN):
npx vitest run tests/e2e/socketio-realtime-contract.test.ts \
               tests/unit/security-boundary-matrix.test.ts
```
