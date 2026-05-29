# pi-crust plan

A mobile-first, self-hosted web control plane for running many concurrent Pi coding-agent sessions from a browser, intended to be accessed remotely over Tailscale.

The design goal is not to mirror Pi's terminal TUI through `xterm.js`; instead, the web app should treat Pi's TUI as the behavioral specification and use the Pi SDK/RPC event model as the structured interface.

## Guiding principles

- Use `@earendil-works/pi-coding-agent` as a library via the SDK where possible.
- Do not fork Pi unless core protocol changes become necessary.
- Prefer structured Pi events over terminal scraping.
- Support many independent sessions concurrently.
- Keep mobile approval/steering workflows first-class.
- Treat the existing Pi TUI features as the parity baseline, but do not let full parity block the first useful release.
- Build test-first around event streams, state reducers, and browser flows.
- Keep Tailscale deployment simple: bind locally or on tailnet interface, add app-level auth token anyway.
- Keep the Pi integration behind an adapter boundary so a mock adapter, SDK adapter, and possible RPC adapter can share the same web/server protocol.

## Product cut-lines

The plan is intentionally comprehensive. Implementation should be staged by usable product cut-lines so the project does not stall chasing full TUI parity before becoming useful.

### Cut-line A — local proof of life

A developer can run the server locally, create one Pi session, send a prompt, and see streamed assistant output in the browser.

Required phases/features:

- Minimal Phase 0
- Minimal Phase 1
- Minimal Phase 2
- A tiny subset of Phase 3 and Phase 4

### Cut-line B — remote mobile supervisor

A developer can access the app over Tailscale from a phone, see multiple sessions, steer/follow-up/abort, and approve extension prompts.

Required phases/features:

- Phase 3 dashboard
- Phase 6 queue/composer basics
- Phase 7 extension UI primitives
- Phase 12 auth/reconnect/mobile basics

### Cut-line C — TUI parity MVP

The pi-crust covers the high-value Pi TUI behaviors: sessions, streaming, tools, queues, model/thinking controls, settings basics, compaction, and tree/fork/clone.

Required phases/features:

- Phases 3–10, excluding package management and advanced theming if needed

### Cut-line D — better-than-TUI parallel coding

The pi-crust adds workflows the TUI does not emphasize: side-by-side sessions, git/worktree orchestration, approval inbox, push notifications, and cost/admin dashboards.

Required phases/features:

- Phase 11
- Phase 12
- selected later enhancements

## Cross-cutting requirements

These apply to all phases.

- Protocol messages must be versioned so old browser tabs fail gracefully after server upgrades.
- Browser state must be reconstructible from server state after refresh/reconnect.
- Large streams and tool outputs must have backpressure/truncation rules.
- Server APIs that touch the filesystem must enforce cwd/root allowlists.
- Browser clients must never be allowed to request arbitrary host paths unless explicitly permitted by server policy.
- All dangerous operations need explicit UI affordances and audit-friendly logs.
- Tests should not require real LLM API calls unless explicitly marked integration/e2e.
- A deterministic mock Pi adapter should exist before the web UI becomes complex.
- The app should prefer progressive enhancement on mobile: every shortcut must have a visible touch UI equivalent.

## Architectural target

```text
Browser / PWA
  ├─ session dashboard
  ├─ active session timeline
  ├─ prompt composer
  ├─ tool cards
  ├─ approval modals
  └─ settings/tree/model panels
        │
        │ WebSocket / HTTP
        ▼
Node server
  ├─ auth / pairing
  ├─ WebSocket fanout
  ├─ SessionRegistry: Map<sessionId, AgentSession>
  ├─ Pi SDK integration
  ├─ resource/extension loading
  └─ optional git/worktree orchestration
        │
        ▼
Pi SDK
  ├─ AgentSession
  ├─ SessionManager
  ├─ SettingsManager
  ├─ ModelRegistry
  └─ tool/event streams
```

---

# Phase 0 — repository and project skeleton

## Goal

Create a clean repository with project conventions, basic tooling decisions, and an initial planning/testing structure.

## Todo

- [x] Initialize git repository.
- [x] Add `plan.md`.
- [x] Decide package manager: npm.
- [x] Decide app layout:
  - [x] `src/server/`
  - [ ] `web/`
  - [x] `src/shared/`
  - [ ] `docs/`
  - [ ] `fixtures/`
- [x] Choose frontend stack.
  - Initial choice: defer frontend framework until Phase 3; TypeScript shared code first.
- [x] Choose backend stack.
  - Initial choice: Node + TypeScript; HTTP/WebSocket framework deferred to Phase 2.
- [x] Choose test stack.
  - Unit/component: Vitest.
  - Browser E2E: deferred; placeholder e2e harness uses Vitest until a browser exists.
- [x] Add formatting/linting conventions.
- [x] Add `.gitignore`.
- [x] Add README with local run/development notes.

## TDD-style tests

- [x] Repository sanity test: project installs cleanly.
- [x] Typecheck command exists and passes.
- [x] Unit test command exists and passes with one placeholder test.
- [x] E2E command exists and can launch a placeholder page/server.

---

# Phase 1 — Pi SDK spike and session registry

## Goal

Prove that the server can create, hold, resume, and dispose multiple independent Pi `AgentSession` instances.

## Todo

- [x] Add dependency on `@earendil-works/pi-coding-agent`.
- [x] Create a minimal server-side Pi adapter.
- [x] Create a mock Pi adapter with deterministic event fixtures for tests and frontend development without API keys.
- [x] Create `SessionRegistry` abstraction.
- [x] Support creating a new persistent session for a cwd.
- [x] Support opening an existing session file.
- [x] Support listing sessions by cwd.
- [x] Support listing all sessions.
- [x] Support disposing idle sessions.
- [x] Ensure each session uses cwd-specific tool factories, not global tool singletons. Current SDK adapter relies on `createAgentSession({ cwd })` defaults, which construct cwd-bound tools.
- [x] Ensure no code calls `process.chdir()`.
- [x] Enforce cwd/project root allowlist before creating/opening sessions.
- [x] Reject session files outside configured session roots.
- [x] Share global `AuthStorage`, `ModelRegistry`, and `SettingsManager` safely.
- [ ] Define internal session handle metadata:
  - [x] session id
  - [x] session file
  - [x] cwd
  - [ ] user/session owner
  - [x] status: idle/running/compacting/retrying/error
  - [x] last activity timestamp

## TDD-style tests

- [x] Creating two sessions returns two different Pi session IDs.
- [x] Creating two sessions returns two different session files.
- [x] Prompting session A does not append messages to session B.
- [x] Aborting session A does not alter session B state.
- [x] Opening an existing session restores its messages.
- [x] Listing sessions includes newly created persistent sessions.
- [x] Disposing a session removes it from the hot registry but leaves its session file on disk.
- [x] Reopening a disposed session restores state from disk.
- [x] Registry rejects unknown session IDs with a typed error.
- [x] Tests assert no `process.chdir()` usage in server code.
- [x] Mock Pi adapter can emit a deterministic assistant response without network/API keys.
- [x] Cwd allowlist rejects disallowed project paths.
- [x] Session-open API rejects session files outside configured roots.

---

# Phase 2 — WebSocket protocol and event-state reducer

## Goal

Define the browser/server protocol and build a deterministic client-side reducer that consumes Pi events into web UI state.

## Todo

- [x] Define shared TypeScript protocol types.
- [x] Add protocol version/feature negotiation.
- [x] Define client-to-server operations:
  - [ ] `list_sessions`
  - [ ] `new_session`
  - [ ] `open_session`
  - [ ] `close_session`
  - [ ] `get_state`
  - [ ] `get_messages`
  - [ ] `prompt`
  - [ ] `steer`
  - [ ] `follow_up`
  - [ ] `abort`
  - [ ] `set_model`
  - [ ] `cycle_model`
  - [ ] `get_available_models`
  - [ ] `set_thinking_level`
  - [ ] `cycle_thinking_level`
  - [ ] `set_session_name`
  - [ ] `get_session_stats`
  - [ ] `get_last_assistant_text`
  - [ ] `bash`
  - [ ] `abort_bash`
  - [ ] `compact`
  - [ ] `set_auto_compaction`
  - [ ] `set_auto_retry`
  - [ ] `abort_retry`
  - [ ] `get_commands`
  - [ ] `fork`
  - [ ] `clone`
  - [ ] `get_fork_messages`
  - [ ] `switch_session`
  - [ ] `export_html`
- [x] Define server-to-client messages:
  - [x] session list response
  - [x] session state update
  - [x] Pi event envelope
  - [x] error envelope
  - [x] extension UI request envelope
- [x] Implement WebSocket connection lifecycle.
- [x] Implement session subscription/fanout.
- [x] Implement reconnect behavior at protocol level.
- [x] Implement state resynchronization after reconnect/refresh.
- [x] Define truncation/backpressure behavior for large tool streams.
- [x] Build client-side event reducer:
  - [x] messages
  - [x] streaming text deltas
  - [x] streaming thinking deltas
  - [x] tool call deltas
  - [x] tool execution state
  - [x] queue state
  - [x] compaction state
  - [x] retry state
  - [x] extension UI state

## TDD-style tests

- [x] Reducer handles `agent_start` and marks session running.
- [x] Reducer handles `agent_end` and marks session idle.
- [x] Reducer merges `message_update` text deltas into one assistant draft.
- [x] Reducer merges thinking deltas into the right content block.
- [x] Reducer creates a tool card on `tool_execution_start`.
- [x] Reducer updates the same tool card on `tool_execution_update`.
- [x] Reducer marks tool success/error on `tool_execution_end`.
- [x] Reducer updates steering/follow-up queues on `queue_update`.
- [x] Reducer tracks compaction lifecycle.
- [x] Reducer tracks retry lifecycle and countdown metadata.
- [x] WebSocket fanout sends session A events only to clients subscribed to session A.
- [x] Reconnected client can request current session state and messages.
- [x] Malformed client messages return typed protocol errors.
- [x] Version mismatch returns clear upgrade/reload instruction.
- [x] Reconnect resync rebuilds active session state without replaying infinite history.
- [x] Large tool stream fixture is truncated or paged according to protocol rules.

---

# Phase 3 — basic web shell and multi-session dashboard

## Goal

Create a usable browser interface for creating, opening, switching, and monitoring multiple sessions.

## Todo

- [x] Create responsive app shell.
- [x] Implement session/project sidebar.
- [x] Implement session list.
- [x] Implement session browser controls matching `/resume`:
  - [x] search sessions
  - [x] toggle path display
  - [x] sort modes
  - [x] named-session-only filter
  - [x] rename from list
  - [x] delete from list with confirmation
- [x] Implement active session view.
- [x] Implement new session flow:
  - [x] choose cwd
  - [ ] optional model
  - [x] optional display name
- [x] Implement open/resume existing session flow.
- [x] Implement close/dispose hot session.
- [x] Implement rename session.
- [x] Implement delete/archive session only after confirmation.
- [x] Show per-session status:
  - [x] idle
  - [x] streaming
  - [x] waiting for approval
  - [x] compacting
  - [x] retrying
  - [x] error
- [x] Show per-session metadata:
  - [x] cwd
  - [x] session id
  - [ ] session file path
  - [ ] parent session path when present
  - [x] session name
  - [x] model
  - [x] token/cache/context usage
  - [ ] cost summary
  - [ ] message/tool counts
  - [x] last activity
- [x] Support mobile navigation between dashboard and active session.

## TDD-style tests

- [x] Dashboard loads with empty session list.
- [x] Creating a session adds it to the dashboard.
- [x] Session search filters by name, cwd, first message, and path.
- [x] Session path toggle shows/hides full paths.
- [x] Named-only filter hides unnamed sessions.
- [x] Sort mode changes session ordering deterministically.
- [x] Opening a session shows its timeline pane.
- [x] Two sessions can be open at once in the hot registry.
- [x] Session A status can be running while Session B remains idle.
- [x] Renaming a session updates the dashboard.
- [x] Deleting a session requires confirmation.
- [x] Mobile viewport shows session switcher and active session without horizontal overflow.
- [x] Refresh/reconnect restores previously open session metadata.

---

# Phase 4 — message timeline and streaming renderer

## Goal

Render Pi conversation state with enough fidelity to replace the basic TUI message area.

## Todo

- [x] Render user messages.
- [x] Render assistant messages with Markdown.
- [x] Render streaming assistant drafts.
- [x] Render thinking blocks.
- [x] Add global thinking hide/show toggle.
- [x] Add per-thinking-block collapse.
- [x] Render assistant metadata:
  - [x] provider
  - [x] model
  - [x] stop reason
  - [x] token usage
  - [x] cost
- [x] Render message errors and aborted messages.
- [x] Render custom messages.
- [x] Render branch summaries.
- [x] Render compaction summaries.
- [x] Implement copy message.
- [x] Implement copy code block.
- [x] Support auto-scroll with user scroll lock.

## TDD-style tests

- [x] User message fixture renders text content.
- [x] User message fixture renders image attachment preview.
- [x] Assistant markdown fixture renders headings/lists/code blocks.
- [x] Streaming text fixture progressively updates one visible assistant draft.
- [x] Thinking fixture renders collapsed when global hide-thinking is enabled.
- [x] Assistant metadata fixture shows model/provider/usage.
- [x] Error assistant fixture shows error state.
- [x] Aborted assistant fixture shows aborted state.
- [x] Custom message fixture renders label and content.
- [x] Branch summary fixture renders summary card.
- [x] Compaction summary fixture renders summary card.
- [x] Copy button copies expected message text.
- [x] Auto-scroll pauses when user scrolls upward.

---

# Phase 5 — built-in tool cards

## Goal

Render Pi tool calls/results as structured web UI cards with live updates.

## Todo

- [x] Create generic `ToolCard` component.
- [x] Implement pending/running/success/error states.
- [x] Implement collapse/expand per tool.
- [x] Implement collapse all / expand all.
- [x] Implement bash renderer:
  - [x] live output
  - [ ] exit code
  - [ ] cancelled state
  - [x] truncation indicator
- [x] Implement read renderer:
  - [x] file path
  - [x] syntax-highlighted preview
- [x] Implement edit renderer:
  - [x] diff viewer
  - [x] added/removed/context coloring
- [x] Implement write renderer.
- [x] Implement grep renderer.
- [x] Implement find renderer.
- [x] Implement ls renderer.
- [x] Implement unknown/custom tool fallback renderer.
- [x] Add copy/download full tool output.

## TDD-style tests

- [x] Generic tool start renders pending/running card.
- [x] Tool update replaces accumulated output without duplicating it.
- [x] Tool success shows success state.
- [x] Tool error shows error state and remains expanded by default.
- [x] Bash fixture renders streamed output and final exit code.
- [x] Read fixture renders file path and highlighted content.
- [x] Edit fixture renders expected diff hunks.
- [x] Grep fixture renders result list with file paths/lines.
- [x] Find fixture renders matched file list.
- [x] Ls fixture renders directory listing.
- [x] Unknown tool fixture renders arguments and result JSON/text.
- [x] Collapse all hides successful tool details.
- [x] Download full output uses full output path/URL when available.

---

# Phase 6 — prompt composer, queues, and attachments

## Goal

Match Pi's editor workflows in web form, including steering/follow-up while an agent is running.

## Todo

- [x] Build multiline prompt composer.
- [x] Persist draft per session.
- [x] Implement prompt history navigation.
- [x] Implement undo/redo or acceptable browser-native equivalent.
- [x] Implement selection copy/cut/paste behavior.
- [x] Implement external-editor analog:
  - [x] open large composer modal
  - [ ] optionally launch configured local editor server-side only if explicitly enabled
- [x] Submit prompt when session is idle.
- [x] When session is streaming, present choices:
  - [x] steer
  - [x] follow-up
  - [x] cancel
- [x] Add explicit buttons for steer/follow-up/abort.
- [x] Show steering queue.
- [x] Show follow-up queue.
- [ ] Allow deleting queued messages.
- [ ] Allow moving queued follow-ups.
- [ ] Allow restoring queued message to editor.
- [x] Implement image upload.
- [x] Implement image paste.
- [x] Implement image drag/drop.
- [x] Implement mobile camera/photo picker.
- [x] Implement `@file` reference autocomplete.
- [x] Implement path completion for file/path-like text.
- [x] Implement slash-command autocomplete.
- [x] Implement shell-command mode for `!command` and `!!command`.
- [x] Implement abort running bash command.
- [x] Render bash mode clearly when composer starts with `!` or `!!`.

## TDD-style tests

- [x] Idle submit sends `prompt` operation.
- [x] Streaming submit opens queue-choice UI instead of blindly sending.
- [x] Steer button sends `steer` operation.
- [x] Follow-up button sends `follow_up` operation.
- [x] Abort button sends `abort` operation.
- [x] Queue update fixture renders steering and follow-up queues.
- [ ] Deleting queued message updates UI optimistically and/or after server ack.
- [x] Draft persists across session switch.
- [x] Prompt history recalls previous prompts for that session.
- [x] Large-composer modal preserves text and selection.
- [x] Pasted image appears as attachment preview.
- [x] Removed attachment is not sent.
- [x] `@` opens file autocomplete.
- [x] Selected file reference is inserted into composer.
- [x] Tab/path completion completes path-like text.
- [x] Dragged image/file appears as attachment preview.
- [x] `/` opens command autocomplete.
- [x] Selecting extension command sends prompt with slash command.
- [x] `!echo hi` runs shell-command path and renders result.
- [x] `!!echo hi` runs hidden shell-command path and marks output excluded from context.
- [x] Abort-bash button cancels running command and updates composer/timeline state.

---

# Phase 7 — extension UI compatibility

## Goal

Support Pi extension UI primitives in the browser so existing extensions can ask for confirmations, inputs, statuses, widgets, and notifications.

## Todo

- [x] Implement extension UI request dispatcher.
- [x] Render `confirm` as modal/bottom sheet.
- [x] Render `select` as modal list.
- [x] Render `input` as prompt dialog.
- [x] Render `editor` as multiline dialog.
- [x] Render `notify` as toast/notification.
- [x] Render `setStatus` as status bar pill.
- [x] Render `setWidget` above/below composer.
- [x] Render `setTitle` in session/browser title.
- [x] Implement `setEditorText` by updating composer draft.
- [x] Handle request timeouts.
- [x] Create or load an `rpc-demo`-style extension fixture to exercise all primitives.
- [x] Add an approval inbox across sessions.

## TDD-style tests

- [x] Confirm request opens modal and returns confirmed true/false.
- [x] Select request opens options and returns selected value.
- [x] Input request returns typed text.
- [x] Editor request returns multiline text.
- [x] Cancelled dialog sends cancellation response.
- [x] Timeout closes dialog without duplicate response.
- [x] Notify request creates toast.
- [x] Status request creates/updates/removes status pill.
- [x] Widget request renders above composer by default.
- [x] Widget request renders below composer when requested.
- [x] Set-title request updates active session title.
- [x] Set-editor-text request replaces composer content.
- [x] Approval inbox shows pending approval from background session.
- [x] Approving from inbox sends response to correct session.

---

# Phase 8 — auth, model, thinking, settings, tools, packages, and resources

## Goal

Replace TUI built-in panels such as `/login`, `/logout`, `/model`, `/scoped-models`, `/settings`, `/hotkeys`, `/reload`, and package/resource management with web-native equivalents.

## Todo

- [x] Auth panel:
  - [x] show provider login/API-key status
  - [x] login provider where supported
  - [x] logout provider
  - [x] enter/update API key
  - [x] show warnings such as Anthropic extra-usage warning
- [x] Model selector:
  - [x] list available models
  - [x] search/filter
  - [x] show provider/model metadata
  - [x] show unavailable models and missing auth reason when possible
  - [x] set model per session
  - [ ] cycle model forward/backward
- [x] Thinking selector:
  - [x] off/minimal/low/medium/high/xhigh
  - [x] hide/show thinking setting
- [ ] Scoped models configuration.
- [x] Active tools configuration:
  - [x] show all built-in, extension, and custom tools
  - [x] enable/disable individual tools for a session
  - [ ] support read-only tool presets
  - [ ] support no-tools mode
- [x] Settings panel:
  - [x] global settings
  - [x] project settings
  - [x] effective merged settings
  - [x] save/flush
- [x] Settings groups:
  - [ ] model/thinking
  - [ ] UI/display
  - [ ] compaction
  - [ ] retry
  - [ ] message delivery
  - [ ] images
  - [ ] shell
  - [ ] sessions
  - [ ] resources
  - [ ] telemetry/update checks
  - [ ] warnings
  - [ ] markdown
  - [ ] npm/package command
- [x] Theme management:
  - [x] dark/light theme selector
  - [ ] custom Pi theme JSON import/discovery
  - [ ] map Pi theme tokens to CSS variables
  - [ ] preview message/tool/diff/thinking colors
- [x] Resource diagnostics panel:
  - [ ] extensions
  - [ ] skills
  - [ ] prompt templates
  - [ ] themes
  - [ ] context files
  - [ ] system prompt files (`SYSTEM.md`, `APPEND_SYSTEM.md`)
  - [ ] package-provided resources
- [ ] Context/system prompt file viewer.
- [x] Package management panel:
  - [x] list installed Pi packages
  - [x] install package from npm/git/path
  - [x] remove package
  - [ ] update all packages
  - [ ] update one package
  - [ ] enable/disable package resources
- [x] Reload resources action.
- [x] Hotkeys/help panel.
- [x] Changelog/version/update notice panel.

## TDD-style tests

- [x] Auth panel shows logged-in/logged-out/API-key states.
- [x] Login/logout flows call server auth API and refresh available models.
- [x] Anthropic extra-usage warning renders when configured.
- [x] Model selector lists mocked available models.
- [x] Selecting model sends `set_model` and updates session state.
- [ ] Cycle model action moves through scoped models.
- [x] Thinking selector sends `set_thinking_level`.
- [ ] Cycle thinking action changes thinking level.
- [x] Hide-thinking setting affects timeline rendering.
- [x] Active tools panel enables/disables tools and updates session state.
- [x] Settings panel displays global/project/effective values.
- [x] Saving global setting writes through server settings API.
- [x] Saving project setting overrides global value.
- [ ] Message delivery setting changes steering/follow-up mode.
- [x] Theme selector applies CSS variables from built-in theme.
- [ ] Custom Pi theme fixture maps required tokens to CSS variables.
- [x] Resource diagnostics display extension load errors.
- [ ] Context/system prompt viewer displays discovered files.
- [x] Package list displays installed package resources.
- [x] Package install/remove/update actions call server package API.
- [x] Reload resources action refreshes command/resource lists.
- [x] Hotkeys panel lists web actions and configured shortcuts.
- [x] Changelog/version panel shows current Pi/server/web versions.

---

# Phase 9 — session tree, fork, clone, and branching

## Goal

Expose Pi's tree-shaped session model in a visual web interface.

## Todo

- [ ] Add server API for session tree data.
- [x] Render visual tree.
- [x] Highlight current leaf.
- [x] Inspect selected entry.
- [x] Filter modes:
  - [x] default
  - [x] no-tools
  - [x] user-only
  - [x] labeled-only
  - [x] all
- [ ] Fold/unfold branch segments.
- [ ] Search tree entries.
- [x] Add/edit/clear labels.
- [ ] Show label timestamps.
- [x] Navigate to selected entry.
- [x] If selected user entry, restore its text into composer for editing/resubmission.
- [x] Support branch summary choices:
  - [x] no summary
  - [x] default summary
  - [x] custom summary instructions
- [x] Implement fork from selected user message.
- [x] Implement clone current active branch.
- [ ] Show parent session breadcrumb.

## TDD-style tests

- [x] Tree fixture renders all branch nodes.
- [x] Current leaf is highlighted.
- [x] User-only filter hides non-user entries.
- [x] No-tools filter hides tool result entries.
- [x] Labeled-only filter shows only labeled entries.
- [x] Selecting an entry shows details panel.
- [x] Editing a label persists via server API.
- [x] Clearing a label removes it from labeled-only view.
- [x] Navigating to user entry restores message text into composer.
- [x] Navigating to assistant entry leaves composer empty.
- [x] Branch summary prompt appears when switching branches.
- [x] Custom branch summary instructions are sent to server.
- [x] Fork creates a new session and shows it in dashboard.
- [x] Clone creates a new session with same active branch.

---

# Phase 10 — compaction, retry, export, and sharing

## Goal

Expose the remaining important TUI lifecycle controls in web-native form.

## Todo

- [x] Full session details panel equivalent to `/session`:
  - [x] session file
  - [x] session id
  - [x] session name
  - [x] message counts
  - [x] tool call/result counts
  - [x] token/cache usage
  - [x] cost
  - [x] context usage
- [x] Context usage meter.
- [x] Manual compaction button.
- [x] Compact with custom instructions.
- [x] Auto-compaction status.
- [x] Render compaction summaries.
- [x] Retry status panel.
- [x] Abort retry.
- [x] Enable/disable auto-retry.
- [x] Copy last assistant message.
- [x] Export session to HTML.
- [x] Export session JSONL.
- [ ] Export selected branch.
- [ ] Optional share integration.
- [x] Changelog/update check integration if not handled in Phase 8.

## TDD-style tests

- [x] Session details panel renders file/id/name/counts/tokens/cost/context usage.
- [x] Context usage meter renders token percentage when available.
- [x] Manual compact sends compact command.
- [x] Custom compact sends instructions.
- [x] Compaction start event shows progress UI.
- [x] Compaction end event renders summary and clears progress UI.
- [x] Compaction failure shows error.
- [x] Retry start event shows attempt/max/delay.
- [x] Retry end success clears retry UI.
- [x] Retry end failure shows final error.
- [x] Abort retry sends command.
- [x] Copy last assistant copies expected text.
- [x] Export HTML downloads/opens generated file.
- [x] Export JSONL downloads original session file.

---

# Phase 11 — file explorer and git/worktree integration

## Goal

Make the web UI better than the TUI for parallel coding by adding project/file/diff/worktree workflows.

## Todo

- [x] Project file explorer.
- [x] File search.
- [x] File viewer with syntax highlighting.
- [x] Markdown preview.
- [x] Image preview.
- [ ] Click file paths in tool results to open file.
- [x] Show files read by session.
- [x] Show files modified by session.
- [x] Git status panel.
- [x] Diff viewer.
- [ ] Stage/unstage files.
- [ ] Commit changes.
- [ ] Optional: create session in new git branch.
- [x] Optional: create session in new git worktree.
- [ ] Optional: compare session output against base branch.
- [ ] Optional: merge/cherry-pick winning session.

## TDD-style tests

- [x] File explorer lists mocked project files.
- [x] Opening file renders highlighted content.
- [x] Markdown file renders preview.
- [ ] Tool result path click opens correct file.
- [x] Git status fixture renders changed files.
- [x] Diff fixture renders added/removed/context lines.
- [x] Create-worktree flow calls expected server API.
- [ ] Session created in worktree uses worktree cwd.
- [ ] Compare sessions shows distinct diffs.

---

# Phase 12 — remote/mobile polish and deployment

## Goal

Make the app reliable and pleasant over Tailscale from a mobile device.

## Todo

- [x] App-level auth token.
- [x] Optional QR pairing flow.
- [ ] Bind/server host configuration for Tailscale.
- [ ] PWA manifest.
- [ ] Mobile home-screen install support.
- [ ] Push notifications:
  - [ ] agent finished
  - [x] approval needed
  - [ ] error/failure
  - [ ] retry exhausted
- [x] Reconnect/resume after phone lock.
- [x] Low-bandwidth mode.
- [x] Approval inbox across all sessions.
- [x] Read-only mode.
- [x] Server admin/status page.
- [x] Idle session disposal policy.
- [x] Cost dashboard.

## TDD-style tests

- [x] Unauthorized requests are rejected.
- [x] Authorized WebSocket connects successfully.
- [x] QR/pairing flow creates valid token.
- [x] Mobile viewport passes critical navigation tests.
- [x] Simulated disconnect/reconnect restores active session.
- [ ] Push notification is requested when approval arrives.
- [x] Approval notification opens correct session.
- [x] Low-bandwidth mode collapses tool output by default.
- [x] Read-only mode disables prompt/tool-mutating actions.
- [x] Idle session disposal removes session from hot registry after timeout.
- [x] Cost dashboard aggregates session usage fixtures.

---

# TUI parity audit checklist

Use this as a final cross-check before calling the pi-crust feature-complete relative to Pi's current interactive TUI.

## Startup/header parity

- [ ] Show cwd/project root.
- [ ] Show loaded context files.
- [ ] Show loaded system prompt files.
- [ ] Show loaded prompt templates.
- [ ] Show loaded skills.
- [ ] Show loaded extensions.
- [ ] Show resource diagnostics and extension load errors.
- [ ] Show startup/update/changelog notices.
- [ ] Support quiet/minimal startup mode.

## Message area parity

- [ ] User messages.
- [ ] Assistant messages.
- [ ] Assistant thinking blocks.
- [ ] Tool calls.
- [ ] Tool results.
- [ ] Bash execution messages.
- [ ] Custom extension messages.
- [ ] Notifications.
- [ ] Errors.
- [ ] Compaction summaries.
- [ ] Branch summaries.
- [ ] Collapsible/expandable tool output.
- [ ] Copy last assistant and copy arbitrary message/code blocks.

## Editor/composer parity

- [ ] Multiline input.
- [ ] Submit vs newline controls.
- [ ] Steering vs follow-up while streaming.
- [ ] Abort active agent run.
- [ ] Restore/dequeue queued messages.
- [ ] `@file` fuzzy file reference.
- [ ] Path completion.
- [ ] Slash command completion.
- [ ] Prompt templates.
- [ ] Skill commands.
- [ ] Extension commands.
- [ ] Image paste/upload/drag-drop/mobile camera.
- [ ] `!command` shell execution.
- [ ] `!!command` hidden shell execution.
- [ ] Abort bash execution.
- [ ] External-editor equivalent for long input.
- [ ] Prompt history and draft persistence.

## Footer/status parity

- [ ] cwd.
- [ ] git branch.
- [ ] session name.
- [ ] session id/file details.
- [ ] current model.
- [ ] thinking level.
- [ ] token/cache usage.
- [ ] cost.
- [ ] context usage.
- [ ] streaming/working indicator.
- [ ] compaction/retry state.
- [ ] extension status entries.
- [ ] extension widgets above/below composer.

## Built-in command parity

- [x] `/login` and `/logout` equivalents, mirroring the TUI's login page feature-for-feature:
  - `/login` opens the interactive dialog: auth-type selector (subscription vs API key) → searchable provider selector with per-provider status indicators (configured / other-type credential / env / runtime / models.json / unconfigured) → OAuth or API-key flow. Providers that support both (e.g. Anthropic) appear in both lists.
  - OAuth dialog: shows + auto-opens the auth URL, instructions, progress, prompts (with `e.g.` hints), interactive selects, and the optional manual-code paste race for callback-server providers; GitHub Copilot shows a waiting message. Success reports "Logged in to <name>"; closing mid-flow cancels server-side.
  - API-key dialog: empty-key error, "Saved API key for <name>"; Amazon Bedrock shows an AWS-credentials info panel instead of a key prompt. Anthropic subscription login surfaces the extra-usage billing warning.
  - `/logout` opens a selector of stored-credential providers only, with subscription vs API-key result wording and an empty-state message. `/login <provider> [key]` / `/logout <provider>` stay one-shots.
  - Server: `/api/auth/providers` classifies providers (`oauthLogin`/`apiKeyLogin`/`credentialType`); the OAuth flow is driven by `OAuthLoginManager` over `/api/auth/oauth/*`.
- [ ] `/model` equivalent.
- [ ] `/scoped-models` equivalent.
- [ ] `/settings` equivalent.
- [ ] `/resume` equivalent.
- [ ] `/new` equivalent.
- [ ] `/name` equivalent.
- [ ] `/session` equivalent.
- [ ] `/tree` equivalent.
- [ ] `/fork` equivalent.
- [ ] `/clone` equivalent.
- [ ] `/compact` equivalent.
- [ ] `/copy` equivalent.
- [ ] `/export` equivalent.
- [ ] `/share` equivalent or explicit non-goal.
- [ ] `/reload` equivalent.
- [ ] `/hotkeys` equivalent.
- [ ] `/changelog` equivalent.
- [ ] `/quit` has a pi-crust analog: close/dispose session or disconnect.

## Package/resource parity

- [ ] `pi install` equivalent for trusted package sources.
- [ ] `pi remove` equivalent.
- [ ] `pi update` equivalent.
- [ ] `pi list` equivalent.
- [ ] `pi config` equivalent for enabling/disabling package resources.
- [ ] Explicit security warnings for packages/extensions because they execute code.

## Settings parity

- [ ] Model/thinking settings.
- [ ] UI/display settings.
- [ ] Theme settings.
- [ ] Compaction settings.
- [ ] Branch summary settings.
- [ ] Retry settings.
- [ ] Message delivery settings.
- [ ] Terminal/image settings mapped to web semantics.
- [ ] Shell settings.
- [ ] Session directory setting.
- [ ] Enabled/scoped models.
- [ ] Markdown settings.
- [ ] Resource path/package settings.
- [ ] Telemetry/update-check settings.
- [ ] Warning settings.

## Known intentional gaps

- [ ] Full terminal `ctx.ui.custom()` component rendering is not planned for v1.
- [ ] Native terminal cursor/IME mechanics are replaced by browser input behavior.
- [ ] Terminal ANSI rendering is replaced by native web components.
- [ ] Shell job control/suspend is not meaningful in pi-crust.

---

# Risk register

## Risk: SDK APIs shift while Pi evolves

Mitigation:

- Keep all direct Pi SDK calls inside a small adapter.
- Prefer documented APIs.
- Add adapter contract tests.
- Consider an RPC adapter if SDK coupling becomes painful.

## Risk: full TUI parity delays useful mobile workflow

Mitigation:

- Follow product cut-lines.
- Ship remote mobile supervisor before full settings/package/theme parity.
- Keep final parity checklist separate from MVP scope.

## Risk: filesystem exposure over remote UI

Mitigation:

- Require project root allowlists.
- Never expose arbitrary server file pickers by default.
- Add explicit read-only mode.
- Log dangerous operations and approval decisions.

## Risk: many concurrent agents overload machine or provider limits

Mitigation:

- Add per-session and global concurrency limits.
- Show running bash/LLM operations in admin UI.
- Add cost dashboard and provider retry visibility.
- Support idle disposal.

## Risk: extension UI compatibility diverges from TUI behavior

Mitigation:

- Use an `rpc-demo`-style fixture as a compatibility test.
- Document unsupported terminal-only `ctx.ui.custom()` behavior.
- Prefer web-native primitives for approvals/status/widgets.

---

# Open design questions

- [ ] SDK-only, RPC-only, or hybrid backend?
  - Current preference: SDK-first, optional RPC adapter later.
- [ ] How much of Pi extension UI should be supported initially?
  - Current preference: support RPC-compatible primitives early; defer full custom TUI component analog.
- [ ] Should sessions be isolated by git worktree by default?
  - Current preference: optional in early versions, recommended for parallel coding later.
- [ ] Should the server support multiple users or just one trusted tailnet user?
  - Current preference: single-user first, but keep session ownership in data model.
- [ ] Should session files remain in Pi's default directory or app-specific directory?
  - Current preference: Pi default initially for interoperability; allow custom session dir later.
- [ ] Should web-native commands exactly mirror slash commands or expose richer menus?
  - Current preference: both; slash palette plus native buttons/modals.
- [ ] How should cwd selection be secured?
  - Need an allowlist/root directory policy before exposing remotely.

# Non-goals for the first version

- Full terminal/TUI emulation through xterm.js.
- Multi-user cloud service.
- Public internet exposure without Tailscale or equivalent private network.
- Maintaining a fork of Pi.
- Implementing Pi's `ctx.ui.custom()` terminal component API directly in web.
- Perfect parity with every TUI keyboard shortcut on mobile.
