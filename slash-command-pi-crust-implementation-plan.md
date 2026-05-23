# Slash Command pi-crust Implementation Plan

Plan for implementing the remaining Pi TUI slash-command behavior in `pi-crust` while reusing existing web UI pieces and translating Pi terminal UI concepts into web-native dialogs, panels, and actions.

## Current state

The pi-crust already has a useful foundation:

- `PromptComposer` routes any input beginning with `/` to `SessionDashboard.onSlashCommand` instead of sending it to Pi as a normal prompt.
- `SessionDashboard` currently implements:
  - `/model` and alias `/models` by opening `ModelPicker`
  - `/session` and alias `/info` as a notice
  - `/new` via the existing create-session flow
  - `/name <name>` via `renameSession`
  - `/quit` and alias `/close` via the delete/close affordance
  - `/help` and `/hotkeys` as a notice
- Several parity-oriented components already exist but are not yet wired into the dashboard:
  - `ConfigurationPanel`
  - `SessionTree`
  - `ProjectExplorer`
  - `ShortcutHelp`
  - `ModelPicker`
  - `ExtensionUiHost`
  - `MessageTimeline` / `ToolCard`
- `src/shared/protocol.ts` already defines many operations needed for parity, including `compact`, `get_commands`, `fork`, `clone`, `switch_session`, and `export_html`, but the HTTP API and adapter do not yet expose most of them.

## TUI commands to cover

Public built-ins from Pi TUI:

| Command | TUI behavior | Current pi-crust status | Target pi-crust behavior |
| --- | --- | --- | --- |
| `/settings` | Open settings selector | Suggested but not implemented | Open configuration/settings modal or side panel |
| `/model [query]` | Open model selector, optionally prefiltered | Partially implemented | Reuse `ModelPicker`, support query prefill |
| `/scoped-models` | Enable/disable models for cycling | Not implemented | Model-scope multi-select modal inside config |
| `/export [path]` | Export HTML by default, JSONL by extension | Not implemented | Export dialog with default path and download/open result |
| `/import <path>` | Import JSONL and resume | Not implemented | Import dialog with path picker/text field and session activation |
| `/share` | Export/share as secret GitHub gist | Not implemented | Either explicit non-goal or guarded share dialog |
| `/copy` | Copy last assistant message | Not implemented | Clipboard action with toast |
| `/name <name>` | Set session display name | Implemented | Keep; also add input dialog for bare `/name` |
| `/session` | Show session info/stats | Minimal notice | Rich session info modal using stats |
| `/changelog` | Show changelog entries | Not implemented | Markdown modal showing Pi/package changelog |
| `/hotkeys` | Show all keyboard shortcuts | Minimal notice + `?` dialog | Open `ShortcutHelp` programmatically or unify help modal |
| `/fork` | Select previous user message and fork to new file | Not implemented | Fork-message picker using `SessionTree`/selector |
| `/clone` | Duplicate current active branch into new session | Not implemented | Confirmation + adapter clone op + activate new session |
| `/tree` | Navigate current session tree | Suggested but not implemented | Open `SessionTree` modal backed by server tree API |
| `/login` | Configure provider auth | Not implemented | Auth modal using config panel/auth flow |
| `/logout` | Remove provider auth | Not implemented | Auth modal or provider selector + confirmation |
| `/new` | Start fresh session | Implemented as create session | Keep; confirm if current active session is streaming |
| `/compact [instructions]` | Manual compaction | Suggested but not implemented | Compact dialog/action with progress, custom instructions |
| `/resume` | Browse/select saved sessions | Not implemented as slash command | Open session picker and activate selected session |
| `/reload` | Reload keybindings/extensions/skills/prompts/themes | Not implemented | Resource reload action with diagnostics |
| `/quit` | Quit app | pi-crust close/delete analog | Clarify semantics: close/dispose session vs disconnect |

Hidden/debug TUI commands (`/debug`, `/arminsayshi`, `/dementedelves`) should remain out of pi-crust parity unless explicitly needed for development.

Dynamic commands also need support:

- Prompt template commands loaded from `.pi/prompts` / user prompts
- Extension commands registered by `pi.registerCommand`
- Skill commands such as `/skill:<name>` when enabled

These should be discovered through `get_commands` and executed through the normal Pi prompt path, not hardcoded as pi-crust built-ins.

## Key design principle: translate, do not embed, TUI components

Pi TUI components are terminal components: they render fixed-width ANSI lines and handle raw key input. The pi-crust should not try to mount those components directly in the browser. Instead, translate their interaction patterns into reusable React components:

| TUI pattern/component | Web translation | Candidate existing/reusable pi-crust component |
| --- | --- | --- |
| `SelectList` / selector dialogs | Searchable list modal with keyboard + touch support | New `SearchableSelectDialog`; reuse `ModelPicker` patterns |
| `SettingsList` | Settings/config side panel with toggles/selects | `ConfigurationPanel`, expanded and integrated |
| `BorderedLoader` | Blocking/non-blocking progress modal or toast with abort | New `ProgressDialog` / existing notices |
| `LoginDialog` / `OAuthSelector` | Auth provider modal + API key/OAuth states | `ConfigurationPanel` auth section |
| `ModelSelectorComponent` | Searchable model modal | `ModelPicker` |
| `ScopedModelsSelectorComponent` | Multi-select model modal | Extend `ModelPicker` or new `ScopedModelsDialog` |
| `SessionSelectorComponent` | Session resume picker | Existing session sidebar + new `ResumeSessionDialog` |
| `TreeSelectorComponent` | Branch tree modal/side panel | `SessionTree` |
| `UserMessageSelectorComponent` | Fork-from-message picker | Reuse `SearchableSelectDialog` or `SessionTree` filtered to user entries |
| `Markdown` | Markdown modal/document viewer | New `MarkdownDialog` |
| `ctx.ui.confirm/input/editor/select` | Generic extension/pi-crust dialogs | `ExtensionUiHost` plus shared dialog primitives |

The reusable target is a small pi-crust dialog toolkit rather than one-off command UIs.

## Architecture changes

### 1. Replace the hardcoded slash switch with a command registry

Create a browser-side command registry, for example:

```text
src/web/commands/
  slash-command-registry.ts
  builtin-slash-commands.ts
  slash-command-types.ts
```

Suggested types:

```ts
interface SlashCommandDefinition {
  name: string;
  aliases?: readonly string[];
  description: string;
  source: "wui-built-in" | "pi-built-in" | "extension" | "prompt" | "skill";
  argumentHint?: string;
  available?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, argv: string) => Promise<void> | void;
}
```

Goals:

- Centralize command metadata for autocomplete, `/help`, and dispatch.
- Keep pi-crust built-ins separate from dynamic Pi commands.
- Allow commands to open modals, call APIs, set notices, or pass through to Pi.
- Make `/help` render from the registry instead of a hardcoded string.

### 2. Expand the pi-crust API surface

Extend `SessionDashboardApi` and `HttpSessionDashboardApi` with focused methods instead of routing everything through `prompt`:

```ts
compact(sessionId, customInstructions?)
exportSession(sessionId, outputPath?, format?)
importSession(path, cwd?)
getSessionStats(sessionId)
getLastAssistantText(sessionId)
getCommands(sessionId)
getSessionTree(sessionId)
navigateTree(sessionId, entryId, options)
forkSession(sessionId, entryId)
cloneSession(sessionId)
resumeSession(sessionFile)
reloadResources(sessionId?)
listAuthProviders()
loginProvider(provider, options)
logoutProvider(provider)
listSettings()
updateSetting(key, value)
listScopedModels(sessionId)
setScopedModels(sessionId, models)
```

Keep path-sensitive operations behind server-side allowlists:

- Import/export paths must pass explicit policy checks.
- Session files must stay under allowed session roots.
- Project/cwd operations must stay under allowed project roots.
- Sharing must be opt-in and should clearly disclose what leaves the machine.

### 3. Extend the Pi adapter boundary

`PiSessionHandle` currently covers only state, messages, prompting, abort, naming, and model selection. Add capabilities in small groups:

```ts
interface PiSessionHandle {
  compact(customInstructions?: string): Promise<CompactionResult>;
  exportHtml(outputPath?: string): Promise<{ path: string }>;
  getLastAssistantText(): Promise<string | null>;
  getStats(): Promise<SessionStatsDetail>;
  getCommands(): Promise<readonly SlashCommandInfo[]>;
  getTree(): Promise<SessionTreeData>;
  navigateTree(entryId: string, options: NavigateTreeOptions): Promise<NavigateTreeResult>;
  fork(entryId: string): Promise<ForkResult>;
  clone(): Promise<CloneResult>;
  reloadResources(): Promise<ResourceReloadResult>;
}
```

For `SdkPiAdapter`, many of these map directly to SDK/RPC concepts:

- `session.compact(customInstructions)` for `/compact`
- `session.exportToHtml` or exported session utilities for `/export`
- `session.messages` for `/copy` and stats
- `pi.getCommands()` / RPC `get_commands` equivalent for dynamic commands
- `AgentSessionRuntime` for replacement flows: `/new`, `/resume`, `/fork`, `/clone`, `/import`
- `session.navigateTree(...)` and `SessionManager.getTree()` for `/tree`
- `SettingsManager`, `AuthStorage`, `ModelRegistry`, and `DefaultResourceLoader.reload()` for settings/auth/reload

Important adapter decision:

- The current pi-crust is multi-session, while Pi TUI has one active runtime that gets replaced for `/new`, `/resume`, `/fork`, `/clone`, and `/import`.
- For simple pi-crust behavior, these commands can create/open/activate sessions in the dashboard.
- For exact extension lifecycle behavior, use `createAgentSessionRuntime()` and preserve the same lifecycle events Pi TUI emits. This is especially important for extension hooks like `session_before_switch`, `session_before_fork`, and `session_shutdown`.

Recommended approach:

1. Implement non-replacement commands with the existing per-session handle.
2. Introduce a runtime-aware adapter for tree/fork/clone/import/resume once the simpler commands are stable.
3. Keep the mock adapter feature-complete enough for unit/e2e tests.

### 4. Prefer WebSocket/RPC-compatible operation names

`src/shared/protocol.ts` already models a richer Pi-like protocol than the current HTTP API. Avoid inventing incompatible names. The HTTP endpoints can be REST-shaped, but internally they should map to the same operation names:

- `compact`
- `get_commands`
- `fork`
- `clone`
- `get_fork_messages`
- `switch_session`
- `export_html`
- `set_thinking_level`
- `cycle_thinking_level`

This makes it easier to move the browser from HTTP+SSE to WebSocket later.

## Command-by-command implementation notes

### `/settings`

Reuse:

- `ConfigurationPanel`
- `ModelPicker` for model sub-flow
- `ShortcutHelp`/hotkey data

Needed:

- Integrate `ConfigurationPanel` into `SessionDashboard` as a modal/side sheet.
- Add server endpoints for settings read/update.
- Add resource diagnostics and theme lists from Pi resource loader/settings manager.
- Split the current all-in-one `ConfigurationPanel` into tabs if it becomes too large: Auth, Models, Tools, Settings, Resources, Packages, Themes.

First cut:

- Open configuration panel with currently mocked/static data replaced by real models and basic settings.
- Make unsafe package management controls read-only or hidden until package security work is done.

### `/model [query]`

Reuse:

- `ModelPicker`

Needed:

- Add optional initial search query prop to `ModelPicker`.
- Parse `/model sonnet` and prefill search with `sonnet`.
- Show unavailable models with reasons if `ModelRegistry` can expose them.
- Update active session state after selection.

### `/scoped-models`

Reuse:

- `ModelPicker` filtering/search UI
- `ConfigurationPanel` model section

Needed:

- Multi-select model dialog.
- Server support for enabled/scoped model list.
- Persist to Pi settings where appropriate.
- Clarify pi-crust equivalent of TUI model cycling if cycling shortcuts are added later.

### `/compact [instructions]`

Reuse:

- Notice/progress UI
- `MessageTimeline` support for compaction summary events

Needed:

- Add adapter `compact` method.
- Add `/api/sessions/:id/compact`.
- Show a confirmation or editor dialog when no inline instructions are supplied.
- Show progress while compacting; support abort if SDK exposes abort compaction.
- Refresh messages/state after completion.

First cut:

- `/compact` opens a small dialog with optional custom instructions.
- `/compact focus on files` starts immediately with those instructions.

### `/session`

Reuse:

- Existing session card data
- `RemoteStatusPanel` patterns if useful

Needed:

- Server `get_session_stats` endpoint.
- Modal showing session file, cwd, id, name, model, message counts, token usage, cost, context usage, hot/cold status.
- Copy buttons for session ID/file path.

### `/copy`

Reuse:

- Browser clipboard API
- Existing notice/toast

Needed:

- API method `getLastAssistantText(sessionId)` or compute from loaded messages.
- Use `navigator.clipboard.writeText` with fallback to selection/download.
- Notice on success/failure.

This is a good early command because it is mostly client-side.

### `/hotkeys` and `/help`

Reuse:

- `ShortcutHelp`
- New command registry metadata

Needed:

- Let `ShortcutHelp` be opened programmatically, not only with `?`.
- `/help` should show a command palette/help dialog generated from the registry plus dynamic `get_commands` results.
- `/hotkeys` should show keyboard shortcuts; `/help` should show commands and shortcuts.

### `/changelog`

Reuse:

- New `MarkdownDialog`

Needed:

- Server endpoint to expose Pi changelog and app version/changelog.
- Render markdown safely. Avoid raw HTML unless sanitized.

First cut:

- Display `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` text through a server endpoint.

### `/tree`

Reuse:

- `SessionTree`

Needed:

- Adapter support for `SessionManager.getTree()`, labels, current leaf, and tree navigation.
- API methods:
  - `getSessionTree(sessionId)`
  - `navigateTree(sessionId, entryId, { summary, customInstructions, label })`
  - `setTreeLabel(sessionId, entryId, label?)`
- Convert Pi session entries to `SessionTreeEntry`.
- Show branch-summary choices using existing `SessionTree` controls.
- After navigating to a user/custom message, prefill `PromptComposer` with restored text.

Implementation detail:

- The existing `SessionTree` component already models filters, labels, fork, clone, navigation, and custom summary instructions. Start by wiring it into a modal and backing it with mock adapter data.

### `/fork`

Reuse:

- `SessionTree` filtered to user entries, or a new `SearchableSelectDialog`
- Existing session activation/list refresh logic

Needed:

- API `getForkMessages(sessionId)`.
- API `forkSession(sessionId, entryId)`.
- Activate the created fork session and prefill the selected user message if Pi returns it.
- Respect extension cancellation when runtime-aware adapter exists.

### `/clone`

Reuse:

- Confirmation dialog
- Existing create/open session UI patterns

Needed:

- API `cloneSession(sessionId)`.
- Activate new cloned session.
- Show cancellation/error states.

### `/resume`

Reuse:

- Existing session sidebar search/sort/filter behavior
- New `ResumeSessionDialog` extracted from sidebar logic if needed

Needed:

- Slash command opens a session picker focused on the current project/session root.
- Selecting a session calls existing open/cold-session path or new `switch_session` operation.
- Decide whether `/resume` means “activate in dashboard” or “replace the active Pi runtime.” For pi-crust multi-session, activation is acceptable for first cut; for exact Pi lifecycle, use runtime switch.

### `/new`

Reuse:

- Existing create session dialog

Needed:

- If active session is streaming, warn or queue action.
- Optionally copy current cwd as default.
- If runtime-aware adapter is adopted, expose Pi `new_session` semantics as distinct from dashboard “create a brand-new independent session.”

### `/export [path]`

Reuse:

- New `ExportDialog`
- Browser download link

Needed:

- API `exportSession(sessionId, outputPath?, format?)`.
- HTML default. Consider JSONL once adapter can export raw session file safely.
- If no path supplied, server can create a file under a configured export directory and return a path/URL.
- Browser download endpoint should stream the generated file.

Security:

- Do not let browser write arbitrary host paths by default.
- Prefer a configured export root or generated temp file.

### `/import <path>`

Reuse:

- New `ImportDialog`
- Existing session activation

Needed:

- Server path policy for import file.
- Adapter/runtime support for `importFromJsonl`.
- Error UI for invalid/missing JSONL.
- After import, list/activate imported session.

First cut:

- Text path field only. Browser file upload can come later if useful.

### `/share`

Needed decision:

- Either declare explicit non-goal for private self-hosted pi-crust, or implement behind a clear opt-in setting.

If implemented:

- Confirmation dialog describing exactly what will be uploaded.
- GitHub token/auth state checks.
- Server endpoint wrapping Pi share/export behavior.
- Audit log entry.

Recommendation:

- Mark as deferred/non-goal until local parity is complete.

### `/login` and `/logout`

Reuse:

- `ConfigurationPanel` auth section
- `ExtensionUiHost` dialog primitives if OAuth/API key flows use extension UI requests

Needed:

- Server provider auth inventory from `ModelRegistry`/`AuthStorage`.
- API key save/remove operations.
- OAuth initiation and callback/code flow. If Pi SDK exposes provider OAuth callbacks, translate those to web dialogs.
- Warnings for subscription/extra-usage auth.

First cut:

- `/login` opens Configuration/Auth tab.
- `/logout` opens provider selector + confirmation.
- API-key based providers first; OAuth second.

### `/reload`

Reuse:

- `ConfigurationPanel` resource diagnostics section

Needed:

- Adapter/resource-loader reload method.
- API `reloadResources(sessionId?)` returning diagnostics for extensions, skills, prompts, themes, context files.
- Refresh command suggestions after reload by calling `get_commands`.
- Refresh theme/settings/model data.

### Dynamic extension/prompt/skill commands

Reuse:

- Existing `PromptComposer` slash routing
- `ExtensionUiHost` for extension UI requests

Needed:

- Add `getCommands(sessionId)` to API.
- Merge built-in pi-crust commands and dynamic commands for autocomplete.
- If a slash command is not a pi-crust built-in but exists in dynamic commands, pass it through to `api.prompt(sessionId, originalText)` so Pi expands/executes it.
- If a slash command is neither built-in nor dynamic, show an unknown-command message with a suggestion to send as plain text.

Important:

- Pi docs say built-in interactive commands are not included in `get_commands`; pi-crust must keep its own built-in registry.
- Dynamic extension commands can trigger UI requests. Ensure `ExtensionUiHost` is connected to the active session event stream before enabling this broadly.

## Reusable pi-crust components to create or extract

### `DialogShell`

Shared modal shell with:

- title
- close button
- mobile-friendly layout
- escape/click-outside handling
- focus trap
- optional footer actions

Use for model picker, settings, tree, export/import, compact, session info, command help.

### `SearchableSelectDialog`

Web translation of TUI `SelectList`:

- query field
- keyboard navigation
- touch-friendly rows
- optional descriptions/badges
- empty state
- async loading/error state

Use for `/resume`, `/fork`, `/login` provider choice, `/logout` provider choice, command palette/help.

### `ConfirmDialog`, `InputDialog`, `EditorDialog`

Shared with `ExtensionUiHost` if possible.

Use for:

- `/compact` instructions
- `/name` bare invocation
- `/clone` confirmation
- `/share` confirmation
- `/import` path
- extension UI requests

### `MarkdownDialog`

Use for:

- `/changelog`
- export preview/help
- rich command docs

### `ProgressDialog` / operation toast

Use for:

- compaction
- export/import
- reload
- share
- OAuth waiting states

Should support cancellation when backend supports it.

## Suggested implementation phases

Implement by dependency/risk order rather than by TUI command order. The early phases should create reusable command and dialog infrastructure; later phases should tackle SDK/runtime replacement, auth, and sharing risks.

### Phase 1 — Slash-command foundation

Purpose: establish the reusable pi-crust command surface before adding many individual commands.

Deliverables:

- Add `src/web/commands/` with:
  - slash command parser
  - command registry
  - built-in command metadata
  - alias resolution
  - unknown-command handling
  - dynamic command metadata shape
- Replace the hardcoded `SessionDashboard.handleSlashCommand` switch with registry dispatch.
- Drive command autocomplete and `/help` from registry metadata.
- Add shared pi-crust primitives:
  - `DialogShell`
  - `SearchableSelectDialog`
  - `ConfirmDialog`
  - `InputDialog`
  - `MarkdownDialog`
- Keep dynamic command discovery mocked or optional; do not require real SDK `get_commands` yet.

Commands covered in this phase:

- `/help`
- `/hotkeys` shell/opening behavior if easy
- improved `/model [query]` opening behavior, without needing settings/auth work

Tests:

- `slash-command-parser.test.ts`
- `slash-command-registry.test.ts`
- dialog primitive tests with accessibility assertions
- `SessionDashboard` tests proving `/help` and `/model <query>` are intercepted and not sent to Pi as prompts

Exit criteria:

- Adding a new pi-crust slash command is a small registry entry plus optional UI/API method.
- Command help/autocomplete are metadata-driven.

### Phase 2 — Low-risk client/UI commands

Purpose: get visible parity wins using existing client state, browser APIs, or read-only panels.

Deliverables:

- Wire existing components into command-opened modals/panels.
- Add lightweight APIs only where needed.
- Avoid deep SDK/runtime replacement semantics.

Commands covered in this phase:

- `/copy`
- `/session`
- `/name` bare invocation as an input dialog; keep `/name <name>` immediate
- `/settings` opens integrated `ConfigurationPanel` with currently available/read-only data
- `/changelog`
- `/hotkeys` fully opens `ShortcutHelp` programmatically

Tests:

- `/copy` copies last assistant text and handles no-message/clipboard-failure cases.
- `/session` opens a rich info dialog with available session fields.
- `/name` without args opens input dialog; with args renames immediately.
- `/settings` opens configuration UI, not fallback notice.
- `/changelog` displays markdown through `MarkdownDialog` and sanitizes/escapes unsafe content.

Exit criteria:

- The pi-crust has a coherent modal/dialog pattern.
- Low-risk commands no longer show “recognized in TUI but not implemented.”

### Phase 3 — Simple server-backed session-local operations

Purpose: introduce adapter/API parity for operations that act on the current session without replacing the active runtime/session.

Deliverables:

- Extend `PiSessionHandle`, `SessionRegistry`, HTTP API, and mock adapter for session-local operations.
- Add server route tests before React wiring.
- Add progress/error UI for longer operations.

Commands covered in this phase:

- `/compact [instructions]`
- `/export [path]`
- `/reload` resource refresh skeleton
- dynamic prompt/template/skill command pass-through via `get_commands`

Notes:

- `/changelog` can be Phase 2 if implemented as read-only file fetch; otherwise keep here if exposed through server package metadata.
- Dynamic commands should be displayed in help/autocomplete and passed through to `api.prompt(sessionId, originalSlashText)`.

Tests:

- Mock adapter tests for compact/export/reload/get_commands.
- HTTP API tests for success, unknown session, and path policy denial.
- UI tests for compact instructions dialog, progress state, success summary, and errors.
- Dynamic command tests for extension/prompt/skill command autocomplete and pass-through.

Exit criteria:

- The pi-crust can safely call non-trivial Pi operations through typed API methods.
- The mock adapter supports all new operations deterministically.

### Phase 4 — Model/config/auth commands

Purpose: handle commands that mutate persistent settings, credentials, model scoping, or resource configuration.

Deliverables:

- Auth provider inventory.
- API-key login/logout flows.
- OAuth flow if practical.
- Scoped model multi-select/reorder UI.
- Real settings read/update for high-value settings.
- Resource diagnostics surfaced in `ConfigurationPanel`.

Commands covered in this phase:

- `/scoped-models`
- `/login`
- `/logout`
- real writable `/settings` sections
- fuller `/reload` diagnostics if not completed in Phase 3

Tests:

- Auth state tests ported from `oauth-selector.test.ts`:
  - stored API key
  - OAuth/subscription credentials
  - environment keys
  - models.json key/command
  - unconfigured providers
- Scoped model ordering tests ported from regression `3217`.
- Settings persistence tests using temp agent/project dirs.
- Missing credentials/unavailable model UI tests.

Exit criteria:

- Settings/auth/model operations are secure, persisted where expected, and clearly distinguish environment vs stored credentials.

### Phase 5 — Tree and branch workflows

Purpose: implement core Pi branching/session-tree features after the command infrastructure and adapter pattern are stable.

Deliverables:

- Wire `SessionTree` into a modal/side panel.
- Add tree conversion APIs and mock tree data.
- Support labels, filters, branch summary choices, and prompt draft restoration.
- Add fork/clone API methods.

Commands covered in this phase:

- `/tree`
- `/fork`
- `/clone`

Tests:

- Tree conversion unit tests.
- `SessionTree` UI tests porting key TUI selector invariants:
  - nearest visible ancestor for metadata leaves
  - filter switching preserves nearest visible ancestor
  - user entries restore editor text
  - non-user entries leave editor empty
  - summary options are passed correctly
  - labels save/clear
- Fork tests porting `agent-session-branching.test.ts` behavior at adapter/mock level.
- Clone tests porting `interactive-mode-clone-command.test.ts`.
- E2E mock-session flow: create session, send prompts, tree/fork/clone.

Exit criteria:

- Branching workflows are usable from mobile/touch UI, not just keyboard shortcuts.
- The pi-crust behavior is documented where it differs from TUI runtime replacement.

### Phase 6 — Resume/import/session replacement semantics

Purpose: tackle the commands where TUI semantics and pi-crust multi-session semantics differ most.

Deliverables:

- Decide and document whether pi-crust slash commands mean:
  - activate another dashboard session, or
  - perform exact Pi `AgentSessionRuntime` replacement semantics.
- Implement session picker dialog extracted from/reusing sidebar behavior.
- Add import JSONL flow with strict path policy.
- Strengthen `/new` semantics if exact runtime replacement is desired.

Commands covered in this phase:

- `/resume`
- `/import <path>`
- stronger `/new` semantics if needed
- clarify `/quit` vs `/close` semantics

Tests:

- Resume picker tests ported from:
  - `session-selector-search.test.ts`
  - `session-selector-rename.test.ts`
  - `session-selector-path-delete.test.ts`
- Import parser/path tests ported from `interactive-mode-import-command.test.ts`:
  - quote stripping
  - apostrophe preservation
  - command token boundaries
  - missing file is non-fatal
- Runtime replacement/stale context tests if adopting exact Pi runtime behavior, porting regression `2860`.
- Path traversal denial tests.

Exit criteria:

- The semantics of switching/resuming/importing are explicit and tested.
- The UI cannot import or switch to disallowed host paths.

### Phase 7 — Share and package-adjacent features

Purpose: leave high-risk upload/install behavior until local/session parity is solid.

Deliverables:

- Decide whether `/share` is supported or an explicit non-goal for private Tailscale deployments.
- Hide, disable, or fully secure package-management equivalents.
- Add audit-friendly confirmations for any upload/install behavior.

Commands/features covered in this phase:

- `/share`
- package management equivalents, if ever added
- trusted package/resource install/remove/update/config flows

Tests if `/share` is deferred:

- `/share` shows explicit unsupported/deferred message.
- No network/upload API is called.

Tests if `/share` is implemented:

- Disabled unless server config enables it.
- Confirmation explains destination and privacy.
- API called only after confirmation.
- API errors are visible and local session state is preserved.

Exit criteria:

- Dangerous operations are opt-in, policy-controlled, and test-covered.

### Recommended first PR

The first PR should be intentionally narrow:

1. Add slash parser and command registry.
2. Replace the dashboard slash switch with registry dispatch.
3. Add `DialogShell`, `SearchableSelectDialog`, and command help dialog.
4. Implement `/help` from registry metadata.
5. Improve `/model [query]` by pre-filling model search.
6. Implement `/copy` if it can be done using already loaded messages; otherwise leave it for Phase 2.

This first PR creates the stable pattern for every later command without blocking on SDK/runtime complexity.

## Server/API route sketch

Keep existing routes, then add:

```text
GET  /api/sessions/:id/stats
GET  /api/sessions/:id/last-assistant-text
GET  /api/sessions/:id/commands
POST /api/sessions/:id/compact
POST /api/sessions/:id/export
GET  /api/sessions/:id/tree
POST /api/sessions/:id/tree/navigate
POST /api/sessions/:id/tree/label
GET  /api/sessions/:id/fork-messages
POST /api/sessions/:id/fork
POST /api/sessions/:id/clone
POST /api/sessions/switch
POST /api/sessions/import
GET  /api/config
POST /api/config/settings
POST /api/config/reload
GET  /api/auth/providers
POST /api/auth/login
POST /api/auth/logout
GET  /api/changelog
```

Long term, consider moving these to the existing WebSocket protocol once the pi-crust is ready for full-duplex command handling.

## Existing tests to reuse and port

There are two useful test sources:

1. This repo's current pi-crust/unit/e2e tests.
2. Pi's own TUI/SDK/RPC tests inside `@earendil-works/pi-coding-agent` / `pi-mono`.

The goal should not be to copy TUI implementation tests mechanically. Instead, extract behavioral invariants from the TUI tests and write pi-crust-first tests that prove the same outcomes through browser-visible UI and server API contracts.

### Current pi-crust tests in this repo

Existing tests already cover many reusable components and should become the base for slash-command TDD:

| Test file | Current coverage | Slash-command relevance |
| --- | --- | --- |
| `tests/unit/prompt-composer.test.tsx` | Slash autocomplete, `!`/`!!` shell routing, normal send behavior | Add command registry dispatch cases, dynamic command suggestions, unknown command behavior |
| `tests/unit/session-dashboard.test.tsx` | Session loading/creation/search/filter/sort, SSE text deltas, rename, prompt limit, delete confirmation | Add slash-command integration tests: each command opens expected modal or calls expected API |
| `tests/unit/model-picker.test.tsx` if added, currently covered through dashboard/playwright | Model selection flows | Add `/model <query>` prefilled search and unavailable model handling |
| `tests/playwright/session-chat.spec.ts` | Browser smoke for `/model` opening picker rather than being sent as prompt | Expand to representative command flows at mobile viewport |
| `tests/unit/configuration-panel.test.tsx` | Auth/model/thinking/tools/settings/resources/packages/themes/hotkeys/versions UI callbacks | Reuse for `/settings`, `/login`, `/logout`, `/scoped-models`, `/reload` |
| `tests/unit/session-tree.test.tsx` | Tree filters, labels, fork, clone, navigate, custom summary instructions | Reuse for `/tree`, `/fork`, `/clone` |
| `tests/unit/extension-ui-host.test.tsx` | Extension UI confirm/select/input/editor/notify/status/widget handling | Required before dynamic extension commands are passed through broadly |
| `tests/unit/message-timeline.test.tsx` | Message/tool rendering | Extend for compaction summaries and branch summaries if not already covered |
| `tests/unit/session-registry.test.ts` | Registry/session lifecycle | Extend for adapter methods used by slash commands |
| `tests/e2e/websocket-server.test.ts` | Protocol/router basics | Extend once commands move to WebSocket protocol |

Immediate pi-crust test additions before implementation:

- `tests/unit/slash-command-registry.test.ts`
- `tests/unit/slash-command-parser.test.ts`
- `tests/unit/searchable-select-dialog.test.tsx`
- `tests/unit/dialog-shell.test.tsx`
- `tests/unit/session-dashboard-slash-commands.test.tsx` or new describe blocks in `session-dashboard.test.tsx`
- Server/API tests for any new route before UI wiring

### Pi TUI/SDK/RPC tests to mine for behavior

Relevant upstream tests found in `pi-mono/packages/coding-agent/test`:

| Upstream test | Behavior to port to pi-crust tests |
| --- | --- |
| `interactive-mode-import-command.test.ts` | `/import` and `/export` path parsing strips quotes, preserves apostrophes, enforces command token boundaries, confirms import, handles missing files non-fatally |
| `interactive-mode-clone-command.test.ts` | `/clone` forks current leaf with `{ position: "at" }`, clears editor, shows success, and handles empty session with “Nothing to clone yet” |
| `interactive-mode-compaction.test.ts` | `compaction_end` rebuilds chat and appends a synthetic compaction summary message |
| `tree-selector.test.ts` | Tree selector chooses nearest visible ancestor for metadata leaves; filter switching preserves nearest visible parent; tree navigation UI invariants |
| `agent-session-tree-navigation.test.ts` | Navigating to user messages restores editor text; navigating to assistant/non-user entries leaves editor empty; branch summaries attach at correct parent; no-op navigation; custom summary instructions |
| `agent-session-branching.test.ts` | Forking from user messages; forking from middle of conversation; selected text returned; new session state after fork |
| `session-selector-search.test.ts` | `/resume` search supports quoted phrase normalization, `re:` regex, invalid regex empty result, relevance/recent sorting, named-only filter |
| `session-selector-rename.test.ts` | Resume picker rename mode and rename callback behavior |
| `session-selector-path-delete.test.ts` | Resume picker delete confirmation, scope toggling current/all, async load race behavior, symlink/parent path handling |
| `oauth-selector.test.ts` | `/login`/`/logout` auth states distinguish API key, OAuth subscription, env vars, models.json keys/commands, and unconfigured providers |
| `suite/regressions/3217-scoped-model-order.test.ts` | Scoped model reordering persists and `/model` scoped tab preserves configured order |
| `suite/regressions/2753-reload-stale-resource-settings.test.ts` | `/reload` applies updated prompt/resource settings after startup |
| `resource-loader.test.ts` | Extension command collisions receive suffixes (`deploy:1`, `deploy:2`); registered command ordering; resource overrides/discovery |
| `rpc.test.ts` and `rpc-client*.test.ts` | RPC command semantics for `compact`, `bash`, state, messages, clone, and command responses |
| `agent-session-compaction.test.ts`, `compaction-extensions.test.ts` | Manual compaction result shape, cancellation, extension-provided compaction, error behavior |
| `agent-session-stats.test.ts` | `/session` stats: tokens, cost, context usage, message/tool counts |
| `export-html-*` tests | Export output security/formatting/XSS safety; useful for `/export` download route tests |
| `settings-manager.test.ts`, `settings-manager-bug.test.ts` | Settings merge/persistence/update behavior for `/settings` |
| `prompt-templates.test.ts`, `skills.test.ts`, `sdk-skills.test.ts` | Dynamic prompt/skill command discovery and expansion behavior |
| `suite/regressions/2023-queued-slash-command-followup.test.ts` | Extension-origin queued slash-command follow-ups should be raw user text, not accidentally re-dispatched |
| `suite/regressions/2860-replaced-session-context.test.ts` | Replacement-session contexts become stale after new/fork/switch/reload; important if pi-crust adopts runtime replacement semantics |
| `suite/regressions/3688-tree-cancel-compacting.test.ts` | Tree navigation cancellation while compacting/branch summarizing |

### TUI-to-pi-crust test-porting principles

For each upstream TUI test, port at one of three layers:

1. **Pure behavior tests** — parsers, registry, data transforms, path parsing, tree conversion.
2. **Server/adapter tests** — exact SDK/RPC operation is invoked; path policies and error mapping are enforced.
3. **React/browser tests** — user types `/command`, sees a dialog/panel, confirms/selects, and observes browser-visible state.

Prefer one test at each layer for high-risk commands instead of many brittle UI tests.

Do not port terminal-specific assertions such as ANSI text, raw key escape codes, line width, or border rendering. Translate them into web-equivalent assertions:

| TUI assertion | pi-crust assertion |
| --- | --- |
| Rendered output contains `ctrl+r rename` | Dialog exposes visible Rename button/help text and keyboard shortcut metadata |
| Raw key `Ctrl+D` enters delete confirmation | User clicks Delete or presses configured shortcut and sees `alertdialog` |
| Selector selected row changes | Listbox option has `aria-selected` / details pane updates |
| Editor text is set | `PromptComposer` draft value changes |
| `showStatus("...")` called | Toast/notice region has message |
| TUI custom dialog returns value | Web modal resolves callback/API call with selected value |
| Component render contains provider status | Auth panel displays status text/badge with accessible name |

## TDD test matrix for slash-command implementation

Write these tests before or alongside implementation. Mark tests `it.todo` or `describe.skip` only if the infrastructure does not exist yet; otherwise prefer failing tests that define the desired behavior.

### Foundation tests

#### Slash parser and registry

File: `tests/unit/slash-command-registry.test.ts`

- Parses `/model sonnet` as `{ name: "model", argv: "sonnet" }`.
- Parses `/name Feature work` preserving spaces in argv.
- Does not treat normal text containing `/` as a slash command unless it starts with `/`.
- Registry resolves aliases (`/models`, `/info`, `/close`) to canonical commands.
- Registry returns built-in command metadata for help/autocomplete.
- Registry merges dynamic commands after built-ins and handles name collisions deterministically.
- Unknown slash command shows a pi-crust notice and is not sent to Pi automatically.
- Dynamic slash command that is not pi-crust built-in is passed through to `api.prompt(sessionId, originalText)`.

#### Shared dialogs

Files:

- `tests/unit/dialog-shell.test.tsx`
- `tests/unit/searchable-select-dialog.test.tsx`
- `tests/unit/command-help-dialog.test.tsx`

Tests:

- Dialogs use `role="dialog"` or `role="alertdialog"`, `aria-modal`, accessible labels, close button.
- Escape and close button dismiss.
- Searchable select filters by label/description and exposes empty state.
- Enter/click selects item; disabled items cannot be selected.
- Mobile-friendly actions are visible; no keyboard-only affordance.
- Command help lists built-ins, aliases, and dynamic commands with source badges.

### `/model` and `/scoped-models`

Files:

- `tests/unit/model-picker.test.tsx`
- `tests/unit/session-dashboard-slash-commands.test.tsx`
- `tests/unit/scoped-models-dialog.test.tsx`

Tests:

- Typing `/model sonnet` opens `ModelPicker` with search prefilled to `sonnet` and does not call `api.prompt`.
- Selecting an available model calls `api.setModel(sessionId, provider, modelId)` and updates active session model.
- Unavailable models render disabled with a reason.
- `/scoped-models` opens multi-select model dialog.
- Reordering scoped models preserves order, porting upstream `3217-scoped-model-order` behavior.
- Persisting scoped models calls API with ordered provider/model IDs.

### `/settings`, `/login`, `/logout`, `/reload`

Files:

- Extend `tests/unit/configuration-panel.test.tsx`.
- Add `tests/unit/auth-panel.test.tsx` if auth is extracted.
- Add server tests for settings/auth/reload endpoints.

Tests:

- `/settings` opens a configuration dialog/panel, not a fallback notice.
- `/login` opens Auth tab/provider selector.
- Auth provider states distinguish stored API key, OAuth/subscription, environment key, models.json key/command, and unconfigured provider, porting `oauth-selector.test.ts`.
- `/logout` asks for provider and confirmation before removing stored credentials.
- Environment credentials are displayed as env-backed and cannot be removed by logout.
- `/reload` calls reload API, refreshes command suggestions, and displays resource diagnostics.
- Reload applies changed prompt/resource settings, porting regression `2753` at adapter/server level.

### `/compact`

Files:

- `tests/unit/session-dashboard-slash-commands.test.tsx`
- `tests/unit/message-timeline.test.tsx`
- Server/adapter compact tests

Tests:

- `/compact` opens custom-instructions dialog when no argv is supplied.
- `/compact focus on files` calls `api.compact(sessionId, "focus on files")` immediately or after confirmation, depending final UX.
- While compacting, session status becomes `compacting` and a progress UI is visible.
- On success, messages/state refresh and a compaction summary appears in timeline, porting `interactive-mode-compaction.test.ts`.
- On cancellation/error, previous messages remain and an error notice is shown.
- Mock adapter records compaction result shape: `summary`, `firstKeptEntryId`, `tokensBefore`, `details`.

### `/session`

Files:

- `tests/unit/session-info-dialog.test.tsx`
- Dashboard slash tests
- Server stats tests

Tests:

- `/session` opens dialog showing session ID, cwd, file, name, model, status.
- Stats include user/assistant/tool counts, token totals, cost, context usage where available.
- Copy buttons copy session ID/file path and report success/failure.
- Missing stats degrade gracefully.

### `/copy`

Files:

- Dashboard slash tests

Tests:

- `/copy` copies last assistant text from loaded messages if available.
- If messages are not loaded or stale, calls `api.getLastAssistantText(sessionId)`.
- If no assistant message exists, shows a non-error notice.
- Clipboard failure shows an actionable error/fallback.
- It never sends `/copy` to the model.

### `/hotkeys`, `/help`, `/changelog`

Files:

- `tests/unit/shortcut-help.test.tsx`
- `tests/unit/command-help-dialog.test.tsx`
- `tests/unit/markdown-dialog.test.tsx`

Tests:

- `/hotkeys` opens the same shortcut help as `?`.
- `/help` opens command help generated from registry and dynamic commands.
- `/changelog` fetches changelog markdown and displays it in a markdown dialog.
- Changelog rendering sanitizes/escapes unsafe HTML if markdown HTML is supported.

### `/tree`

Files:

- Extend `tests/unit/session-tree.test.tsx`.
- Add `tests/unit/session-tree-data.test.ts` for conversion from Pi entries.
- Add server/adapter tree tests.

Tests:

- `/tree` opens `SessionTree` modal with entries from API.
- Current leaf is highlighted; if current leaf is metadata, nearest visible ancestor is selected, porting `tree-selector.test.ts`.
- Filter changes (`default`, `no-tools`, `user-only`, `labeled-only`, `all`) preserve nearest visible ancestor where possible.
- Selecting a user entry calls `onRestoreUserMessage` and pre-fills `PromptComposer` draft.
- Selecting an assistant/tool/summary entry does not prefill draft.
- Navigating with no summary creates no summary entry.
- Navigating with default/custom summary calls API with correct options.
- Custom summary instructions are preserved.
- Label save/clear calls API and updates UI.
- Cancelled branch summarization leaves UI/session unchanged.

### `/fork` and `/clone`

Files:

- Dashboard slash tests
- `tests/unit/fork-message-dialog.test.tsx`
- Server/adapter fork/clone tests

Tests:

- `/fork` opens user-message picker from `api.getForkMessages(sessionId)`.
- Selecting a message calls `api.forkSession(sessionId, entryId)`.
- New fork session is added/activated.
- Selected text is restored into prompt draft when API returns it, matching Pi behavior.
- Forking from middle of conversation preserves prior context, covered at adapter/mock level.
- `/clone` asks for confirmation if desired, then calls `api.cloneSession(sessionId)`.
- Clone with no current leaf shows “Nothing to clone yet,” porting `interactive-mode-clone-command.test.ts`.
- Clone success clears draft and activates new session.

### `/resume`, `/new`, `/name`, `/quit`

Files:

- Dashboard tests
- `tests/unit/resume-session-dialog.test.tsx`
- Existing session sidebar tests can be extracted/reused

Tests:

- `/resume` opens session picker with current/all scope, search, sort, named filter.
- Search supports quoted phrase normalization and `re:` regex; invalid regex returns empty result, porting `session-selector-search.test.ts`.
- Picker supports rename and delete confirmation as visible controls, porting `session-selector-rename` and `session-selector-path-delete` behavior.
- Async “all sessions” load resolving after switching back to current scope does not overwrite current scope.
- Selecting a session activates it and loads messages.
- `/new` opens create-session dialog with cwd defaulted from active session.
- `/name` with no argv opens input dialog; `/name Some Name` renames immediately.
- `/quit` behavior is clarified in tests once product semantics are decided. Until then, test current alias behavior as `/close` and avoid destructive delete surprises.

### `/export` and `/import`

Files:

- `tests/unit/export-dialog.test.tsx`
- `tests/unit/import-dialog.test.tsx`
- Parser/path tests
- Server path-policy tests

Tests:

- Shared parser strips quotes for `/export "path with spaces/out.html"` and `/import "path with spaces/session.jsonl"`.
- Parser preserves apostrophes in unquoted paths.
- Parser enforces command token boundaries: `/exporter` and `/important` are not parsed as `/export` or `/import`, porting `interactive-mode-import-command.test.ts`.
- `/export` without path opens dialog/default export action.
- Export success returns a download link or path notice.
- Export route denies output outside allowed export root unless explicitly configured.
- `/import` without path opens path dialog.
- `/import <path>` asks confirmation before replacing/activating session.
- Missing import file is shown as non-fatal error.
- Invalid JSONL is shown as validation error.
- Import path traversal is denied.

### `/share`

Files:

- Dashboard slash tests
- Server share tests if implemented

Tests if deferred:

- `/share` shows explicit “not supported in pi-crust yet” message with no upload side effects.

Tests if implemented:

- Share is disabled unless a server config flag is enabled.
- Confirmation explains upload destination and privacy.
- Share calls API only after confirmation.
- API errors are visible and do not lose local export.

### Dynamic commands: extension, prompt, skill

Files:

- Registry tests
- Dashboard tests
- API tests for `get_commands`
- Extension UI host tests

Tests:

- `api.getCommands(sessionId)` results appear in autocomplete/help with source labels.
- Duplicate extension command names use suffixed invocation names (`deploy:1`, `deploy:2`) and preserve ordering, porting `resource-loader.test.ts`.
- Prompt template and skill commands are displayed as dynamic commands.
- Selecting/typing a dynamic command passes original slash text to `api.prompt` and does not show pi-crust fallback.
- Dynamic command UI requests are rendered by `ExtensionUiHost`.
- Extension-origin queued slash-command follow-ups are treated as raw user text, not re-dispatched as pi-crust commands, porting regression `2023`.

## Testing strategy

- Keep the mock adapter deterministic and feature-complete for every new command.
- Unit-test command registry independently from React.
- Unit-test each dialog component independently.
- Add dashboard integration tests for slash-command entry points.
- Add server tests for path policies and session lifecycle operations.
- Add Playwright smoke tests for mobile-sized viewport command flows.
- Do not require real LLM/API credentials for default tests.
- Treat Pi TUI/SDK/RPC tests as behavior specs; link or cite the source test when porting a behavior.
- For every command, add tests in this order: parser/registry, mock API/adapter, React UI, then e2e smoke if the flow is important on mobile.
- Keep upstream LLM-dependent cases as adapter contract tests with mock data unless explicitly marked integration.

## Security and product guardrails

- Browser must never request arbitrary host paths without server policy approval.
- Import/export/share need explicit UI warnings and safe defaults.
- Package install/remove should remain hidden or disabled until trust model is designed.
- Auth changes should distinguish environment credentials from stored credentials.
- Share/upload must be opt-in and audit-friendly.
- Commands that mutate sessions (`/compact`, `/tree`, `/fork`, `/clone`, `/import`, `/new`, `/resume`) should confirm when risk is high or when active work is streaming.
- Every keyboard shortcut should have a visible touch equivalent.

## Open questions

1. Should `/quit` delete/dispose the active session, close the browser connection, or stop the server? Current pi-crust behavior maps it to close/delete; this should be renamed or clarified.
2. Should `/resume`, `/new`, `/fork`, `/clone`, and `/import` use exact Pi runtime replacement semantics or pi-crust multi-session activation semantics?
3. Should `/share` be supported at all in a private Tailscale-first app?
4. Should `/export` allow arbitrary output paths, or only download/generated export locations?
5. Should the pi-crust eventually consume Pi RPC mode directly instead of maintaining an SDK adapter?
6. How much of package management belongs in this pi-crust, given the security implications of installing executable extensions remotely?
