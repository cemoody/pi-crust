# Realtime transport (Socket.IO) — TDD contract

Goal: replace the hand-rolled SSE/`ws` lifecycle plumbing with **one multiplexed
Socket.IO connection per browser origin**, while keeping pi-crust's own
sequence/ring-buffer/replay semantics and keeping REST as REST.

This document is the spec the test harness encodes. Tests live in:

- `tests/e2e/socketio-realtime-contract.test.ts` — core protocol
- `tests/e2e/socketio-realtime-resilience.test.ts` — reconnect/resume + coexistence
- `tests/helpers/realtime-test-harness.ts` — shared adapter/server harness

## Status legend

- 🔴 **RED** = describes new surface; fails until the gateway is implemented.
- 🟢 **GREEN** = invariant that must keep holding (REST stays REST).

## Wire protocol

The gateway is mounted on the **same `http.Server`** returned by
`createHttpApiServer`, under the default `/socket.io/` path. REST and SSE are
untouched.

### Client → server (with ack callback)

| event                 | payload                              | ack                                                   |
| --------------------- | ------------------------------------ | ----------------------------------------------------- |
| `session:subscribe`   | `{ sessionId, fromSeq: number\|null }` | `{ ok: true, sessionId, lastSeq }` or `{ ok:false, error }` |
| `session:unsubscribe` | `{ sessionId }`                      | `{ ok: true }`                                        |

### Server → client

| event           | payload                                  |
| --------------- | ---------------------------------------- |
| `session:event` | `{ sessionId, seq, event }` (event is a `PiEvent`) |

`event` may itself be a synthetic `{ type: "session_resync", fromSeq, ringLowSeq, lastSeq }`
when the requested `fromSeq` predates the replay ring.

## Contract (🔴 RED until implemented)

1. **Live streaming during in-flight prompt** — events arrive on the socket
   while the REST `POST /prompt` is still blocked. Seqs are `1,2,3…`.
2. **Multiplexing** — many `session:subscribe` calls share ONE physical
   socket. This is the per-origin connection-budget fix.
3. **Replay by seq** — `subscribe(fromSeq)` replays buffered events `> fromSeq`
   before going live; ack reports current `lastSeq`.
4. **Gap → resync** — `fromSeq` older than the ring low yields a
   `session_resync` marker, then the surviving ring entries.
5. **Unsubscribe** — stops one logical subscription without closing the socket.
6. **Unknown session** — rejected via ack (`ok:false`), socket stays connected.
7. **Reconnect/resume** — after a transport drop, a fresh socket resuming from
   the last acked seq receives exactly the missed events, with no
   double-delivery of already-acked seqs.

## Invariants (🟢 GREEN — must not regress)

- JSON REST routes (`GET /api/sessions`, etc.) keep working on the shared server.
- Legacy SSE (`GET /api/sessions/:id/events`) keeps working as a fallback.
- `/socket.io/` does not shadow `/api/*`; unknown `/api` routes still 404 JSON.
- Existing SSE eviction-by-tab + sequence/ring tests remain green.

## Client-side rollout — TDD layers (RED, pre-implementation)

The server gateway above is implemented + green. The browser side is specified
but NOT yet implemented; `createRealtimeConnection` throws so its tests are RED.
Seam: `src/web/api/realtime-connection.ts` (will back `SessionDashboardApi.streamEvents`).

Harness: `tests/helpers/realtime-client-harness.ts` — injectable `FakeTransport`,
`FakeBroadcastHub`/`FakeBroadcastChannel`, `FakeVisibility` (DOM-free, deterministic).

| Layer | File | What it pins |
| ----- | ---- | ------------ |
| Single-tab multiplexing | `tests/unit/realtime-connection.test.ts` | one transport for N subscriptions; envelope-unwrap routing; ref-counted sub/unsub; idle teardown; reconnect→resume-by-seq; `stream_reconnected`; `session_resync` passthrough; visibility pause/resume |
| Cross-tab leader election | `tests/unit/realtime-leader-election.test.ts` | N tabs → 1 transport; leader fans events to followers over BroadcastChannel; follower promotion + re-subscribe on leader loss |
| Client ↔ real gateway | `tests/e2e/realtime-client-gateway.test.ts` | the connection driving real socket.io-client against the real server multiplexes + routes live |

Still to add before/with implementation:
- **Transport-selection / feature flag** parity suite: same `streamEvents` contract
  satisfied by both the SSE path and the Socket.IO path; flag picks one; SSE stays
  the fallback until the new path soaks.
- **Playwright leader-election end-to-end**: N real tabs → exactly one server-side
  socket connection (assert via `io.engine.clientsCount` / a debug stat).
- **Mobile/background parity**: reuse the existing mobile-reconnect Playwright
  suites against the Socket.IO path.

## Out of scope (later)

- API ↔ supervisor IPC transport (separate layer; consider `vscode-jsonrpc`).
- Multi-process API scale-out (Socket.IO sticky sessions + shared adapter) — only
  if/when pi-crust runs more than one API process.

## Run

```bash
# new surface (expect RED until implementation):
npx vitest run tests/e2e/socketio-realtime-contract.test.ts \
               tests/e2e/socketio-realtime-resilience.test.ts

# invariants (expect GREEN):
npx vitest run tests/e2e/http-api-sse.test.ts \
               tests/e2e/http-api-sse-eviction.test.ts \
               tests/e2e/websocket-server.test.ts
```
