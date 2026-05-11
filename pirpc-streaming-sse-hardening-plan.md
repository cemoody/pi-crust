# Pi RPC Streaming + SSE Hardening Plan

## Context

PR #3 adds a selectable `pirpc` adapter that launches `pi --mode rpc` subprocesses and forwards Pi RPC JSONL events into the existing session subscription path. The current browser transport remains the existing HTTP/SSE endpoint:

```txt
pi --mode rpc stdout JSONL
  -> PiRpcAdapter
  -> SessionRegistry.subscribe(...)
  -> GET /api/sessions/:id/events
  -> Browser EventSource
  -> SessionDashboard.applyRealtimeEvent(...)
```

This plan is for hardening that path so switching to Pi RPC does not regress the current live streaming experience, and so Pi RPC-specific event types such as `extension_ui_request` become first-class in the HTTP/SSE WUI path.

## Goals

1. Preserve assistant text streaming over SSE.
2. Preserve thinking streaming over SSE.
3. Preserve tool lifecycle streaming over SSE:
   - `tool_execution_start`
   - `tool_execution_update`
   - `tool_execution_end`
4. Preserve artifact rendering from `result.details.piRemoteControlArtifact`.
5. Add first-class extension UI request handling over the HTTP/SSE path.
6. Add automated coverage for the streaming event bridge.
7. Add a manual smoke-test checklist for real Pi RPC sessions.

## Non-goals for this pass

- Detaching Pi RPC workers from the API process.
- Building a session-host/supervisor daemon.
- Full WebSocket replacement for SSE.
- Streaming partial artifact previews before tool completion.
- Trusting/rendering unsandboxed arbitrary HTML.

Those are follow-up efforts.

## Current behavior to preserve

The WUI already handles these real-time event patterns in `SessionDashboard.applyRealtimeEvent`:

| Event | Current WUI behavior |
|---|---|
| `agent_start` | active session status becomes `streaming` |
| `message_start` | assistant/user message shell is added |
| `message_update` with `text_delta` | assistant draft text appends incrementally |
| `message_update` with `thinking_delta` | thinking text appends incrementally |
| `message_end` | assistant draft finalizes |
| `agent_end` | session returns idle and schedules refresh |
| `tool_execution_start` | tool card appears |
| `tool_execution_update` | tool output updates while running |
| `tool_execution_end` | tool card finalizes |

## Risks to address

### 1. HTTP prompt request waits for `agent_end`

The current API route awaits `registry.prompt(...)`, and the Pi RPC adapter waits for `agent_end` before resolving. This is okay as long as the separate SSE connection remains active and events flush immediately.

Validation needed:

- Browser sends `POST /prompt`.
- SSE receives `message_update` before the POST completes.
- UI updates live during the request.

### 2. EventSource only receives generic events

The SSE endpoint currently sends raw event payloads as default `message` events:

```txt
data: {...}
```

That works for `SessionDashboard.applyRealtimeEvent`, but extension UI events need a clear browser-side dispatch path.

### 3. Extension UI requests are not first-class in HTTP/SSE path

Pi RPC can emit:

```json
{
  "type": "extension_ui_request",
  "id": "...",
  "method": "confirm",
  "title": "Allow dangerous command?"
}
```

The WUI has `ExtensionUiHost`, but the HTTP/SSE dashboard path does not yet wire Pi RPC `extension_ui_request` events into it, nor does the HTTP API expose `extension_ui_response`.

### 4. Tool args can be lost on update/end events

The current realtime merge uses `{}` for args on `tool_execution_update` / `tool_execution_end` and relies on merge behavior to preserve previous args. This should be explicitly tested for Pi RPC event sequences.

### 5. Artifact metadata should survive stream refreshes

Artifact metadata is currently extracted from live `tool_execution_end` events. We should decide whether historical `getMessages()`/refresh can reconstruct artifact cards from session history, or whether artifacts are live-only for this pass.

For this pass: live rendering is enough, but document historical replay as follow-up unless cheap.

## Implementation phases

## Phase 1: Streaming bridge tests

Add tests that simulate a Pi RPC event sequence through the same WUI update functions used by SSE.

Coverage:

1. Assistant text streaming:
   - `agent_start`
   - `message_start`
   - multiple `message_update text_delta`
   - `message_end`
   - `agent_end`
   - assert final timeline text and session status.

2. Thinking streaming:
   - multiple `thinking_delta`
   - assert thinking block accumulates.

3. Tool output streaming:
   - `tool_execution_start` with args
   - multiple `tool_execution_update`
   - `tool_execution_end`
   - assert output updates and final status is success/error.

4. Artifact result:
   - `tool_execution_end` with `details.piRemoteControlArtifact`
   - assert `MessageTimeline` renders an artifact preview.

Possible approaches:

- Extract `applyRealtimeEvent` from `SessionDashboard.tsx` into a testable module, e.g. `src/web/state/realtime-event-bridge.ts`.
- Or use component-level tests with a fake `SessionDashboardApi.streamEvents` that emits events.

Preferred: extract a pure helper so behavior is covered without fragile component setup.

## Phase 2: First-class extension UI events over SSE

### Browser state

Add extension UI state to `SessionDashboard` or a small reducer:

```ts
type ExtensionUiBySession = Record<string, readonly ExtensionUiRequest[]>;
```

When SSE event is:

```ts
{ type: "extension_ui_request", ... }
```

convert it to the existing `ExtensionUiRequest` type and append/upsert by id.

### Rendering

Render `ExtensionUiHost` for the active session, likely near the composer or above/below the timeline.

### Response API

Add HTTP route:

```txt
POST /api/sessions/:sessionId/extension-ui-response
```

Body options:

```ts
type ExtensionUiResponseBody =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };
```

Adapter interface addition:

```ts
interface PiSessionHandle {
  respondToExtensionUi?(response: ExtensionUiResponse): Promise<void>;
}
```

For Pi RPC adapter, send JSONL to stdin:

```json
{"type":"extension_ui_response","id":"...","value":"..."}
```

For SDK/mock adapters, either no-op with an error or return a clear unsupported response.

### WUI API addition

Add optional methods to `SessionDashboardApi`:

```ts
respondToExtensionUiValue(sessionId: string, id: string, value: string): Promise<void>;
respondToExtensionUiConfirm(sessionId: string, id: string, confirmed: boolean): Promise<void>;
respondToExtensionUiCancel(sessionId: string, id: string): Promise<void>;
```

Or one generic method:

```ts
respondToExtensionUi(sessionId: string, response: ExtensionUiResponse): Promise<void>;
```

Preferred: one generic method, because it maps directly to Pi RPC.

## Phase 3: SSE transport validation

Add a server-level test for `/api/sessions/:id/events` with a fake adapter that emits delayed events while a prompt is in flight.

Assertions:

1. SSE connection receives `agent_start` before prompt completes.
2. SSE connection receives `message_update` before prompt completes.
3. SSE connection receives `agent_end` eventually.
4. Heartbeat does not interfere with parsing.

This protects against accidentally buffering until request completion.

## Phase 4: Manual smoke checklist

Add to README or a new docs file:

```bash
PI_REMOTE_ADAPTER=pirpc npm run dev:api
npm run dev
```

Smoke prompts:

1. Text stream:
   - "Write a 10 bullet explanation of this repo slowly enough that I can watch it stream."

2. Tool stream:
   - "Run `find src -maxdepth 2 -type f | sort` and summarize the result."

3. Artifact:
   - "Use show_artifact to display a markdown artifact titled Demo with a short heading and paragraph."

4. Extension UI:
   - Use or add a tiny test extension that calls `ctx.ui.confirm(...)`, then verify the browser dialog can answer it.

Expected results:

- Assistant text appears incrementally.
- Tool card appears before completion.
- Tool output updates before completion.
- Artifact renders after `show_artifact` finishes.
- Confirm/select/input/editor requests appear in the WUI and responses unblock the agent.

## Phase 5: Documentation

Update README with:

- `PI_REMOTE_ADAPTER=pirpc` usage.
- What streams over SSE.
- Extension UI limitations/status.
- Artifact security note: raw HTML is sandboxed.
- Known limitation: Pi RPC workers are still children of the API process until the detached worker/session-host phase.

## Acceptance criteria

- `npm run check` passes.
- `npm run build` passes.
- Automated tests prove assistant/tool streaming events are handled incrementally.
- Automated tests prove extension UI requests are received and responses are sent to Pi RPC.
- Manual smoke checklist passes against a real `PI_REMOTE_ADAPTER=pirpc` session.
- No regression to mock adapter tests.
- No regression to current SDK adapter compile path.

## Follow-up work

1. Detached Pi RPC worker/session-host so API restarts do not kill live sessions.
2. Historical artifact replay from persisted Pi session files.
3. Artifact file serving/copying into a controlled per-session artifact directory.
4. Optional named SSE event types instead of only default `message` events.
5. WebSocket parity for extension UI requests/responses if the WebSocket protocol becomes the primary transport.
