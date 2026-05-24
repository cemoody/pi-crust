# pi-crust extension/package test parity with Pi Coding Agent

This inventories Pi Coding Agent tests that are relevant to pi-crust's emerging extension/package framework and tracks what pi-crust now covers in this worktree.

## Highly relevant Pi tests

### `packages/coding-agent/test/extensions-discovery.test.ts`

Relevant behaviors:

- discover direct `.ts`/`.js` files in an `extensions/` directory;
- discover one-level subdirectories with `index.ts`/`index.js`;
- prefer TypeScript/index variants deterministically;
- subdirectory `package.json` extension manifest;
- manifest declares multiple extensions;
- manifest takes precedence over fallback `index`;
- package without extension manifest falls back to `index`;
- ignore subdirectory without manifest/index;
- do not recurse arbitrarily into helper modules;
- mixed direct files + subdirectories;
- skip nonexistent manifest paths;
- explicit paths only load explicit paths;
- load extension and verify command/tool/renderer/event/shortcut/flag contribution;
- invalid code / missing export / initialization throw yields diagnostics.

pi-crust coverage now:

- package manifest single entry: `tests/unit/extension-package-resolver.test.ts`;
- package manifest multiple entries: `tests/unit/extension-loader.test.ts`;
- package-root manifest precedence over index: `tests/unit/extension-package-resolver.test.ts`;
- package without pi-crust manifest falls back to index: `tests/unit/extension-package-resolver.test.ts`;
- include/exclude manifest patterns: `tests/unit/extension-package-resolver.test.ts`;
- Pi-like one-level extension directory discovery: `tests/unit/extension-package-resolver.test.ts`;
- subdirectory manifest precedence over index: `tests/unit/extension-package-resolver.test.ts`;
- dynamic loader module shapes: default function, named `activate`, default object with `activate`: `tests/unit/extension-loader.test.ts`;
- dynamic loader no-activate and syntax-error failures: `tests/unit/extension-loader.test.ts`;
- import + activate installed package and verify command: `tests/integration/extension-install.test.ts`;
- activation error isolation: `tests/unit/extension-registry.test.ts`.

Still relevant/not fully covered:

- direct discovery/import of `.ts` through runtime loader; current dynamic loader tests verify `.mjs` only;
- explicit `--extension/-e` paths once CLI parsing exists;
- web-specific contributions for renderers/shortcuts once those registries exist.

### `packages/coding-agent/test/extensions-runner.test.ts`

Relevant behaviors:

- collect commands from multiple extensions;
- suffix duplicate command invocation names in insertion order;
- get command by invocation name;
- error isolation for throwing handlers/listeners;
- contribution conflict behavior;
- disposable/unregister behavior;
- shortcut conflicts with reserved/builtin bindings;
- message renderers/flags/provider/tool hooks, where analogous pi-crust registries exist later.

pi-crust coverage now:

- command registration/execution: `tests/unit/extension-registry.test.ts`;
- duplicate command suffixing: `tests/unit/extension-registry.test.ts`;
- slash-command metadata lookup: `tests/unit/extension-registry.test.ts`;
- duplicate slash names keep first registered command: `tests/unit/extension-registry.test.ts`;
- activity registration/disposal: `tests/unit/extension-registry.test.ts`;
- activation error isolation: `tests/unit/extension-registry.test.ts`;
- partial activation cleanup: `tests/unit/extension-registry.test.ts`;
- full host disposal cleanup and returned disposable order: `tests/unit/extension-registry.test.ts`;
- duplicate route registration cleanup: `tests/unit/extension-registry.test.ts`;
- activation precedence contract: explicit, project, global, built-in: `tests/unit/extension-registry.test.ts`;
- built-in extensions use the same host activation path as external extensions: `tests/unit/extension-registry.test.ts`;
- server route registration/dispatch: `tests/unit/extension-registry.test.ts`, `tests/e2e/http-api-extension-route.test.ts`.

Still relevant/not fully covered:

- throwing command handler diagnostics; current command `run` propagates errors;
- duplicate activity-view conflict diagnostics beyond throwing;
- future registries: toolbar actions, composer contributions, artifact renderers, keyboard shortcuts.

### `packages/coding-agent/test/package-manager.test.ts`

Relevant behaviors:

- no configured package sources returns no package-sourced resources;
- resolve local extension paths from settings;
- project paths relative to project `.pi`/settings base;
- symlinked user/project resources dedupe;
- resolve directory package manifests;
- resolve package auto-discovery layout;
- source parsing for local/npm/git/GitHub sources;
- settings source normalization and equivalent-path removal;
- pattern filtering in top-level arrays, manifests, and package filters;
- layering user filters on top of manifest filters;
- force include `+` and force exclude `-` patterns;
- package deduplication, project scope wins over global;
- multi-file extension discovery: only top-level direct files and subdirectory index/manifest, not helper modules;
- npm/git install/update/offline behavior once pi-crust package manager supports network package sources.

pi-crust coverage now:

- resolve installed local package settings with supplied cwd: `tests/unit/extension-package-resolver.test.ts`;
- empty/no package sources: `tests/unit/extension-package-resolver.test.ts`;
- no-extensions/disable-loading contract: `tests/unit/extension-package-resolver.test.ts`;
- ignore non-extension files: `tests/unit/extension-package-resolver.test.ts`;
- resolve package manifest: `tests/unit/extension-package-resolver.test.ts`;
- auto-discovery layout one-level semantics: `tests/unit/extension-package-resolver.test.ts`;
- directory manifest patterns discover extension-style entries without helper modules: `tests/unit/extension-package-resolver.test.ts`;
- pattern include/exclude: `tests/unit/extension-package-resolver.test.ts`;
- layered manifest + package filters: `tests/unit/extension-package-resolver.test.ts`;
- force include/exclude and force-exclude-wins behavior: `tests/unit/extension-package-resolver.test.ts`;
- global/project dedupe with project winning: `tests/unit/extension-package-resolver.test.ts`;
- symlinked package dedupe by real path: `tests/unit/extension-package-resolver.test.ts`;
- missing explicit manifest path diagnostics vs empty glob matches: `tests/unit/extension-package-resolver.test.ts`;
- install local package settings: `tests/integration/extension-install.test.ts`;
- equivalent path removal with trailing slash: `tests/integration/extension-install.test.ts`.

Still relevant/not fully covered:

- npm/git source parsing/install/update/offline behavior;
- project-local settings file semantics once pi-crust exposes them;
- package resource types beyond extensions, e.g. themes/prompts if pi-crust adds them.

### `packages/coding-agent/test/package-command-paths.test.ts`

Relevant behaviors:

- `install ./local-package` persists paths relative to settings;
- remove local package using trailing slash/equivalent path;
- install help/unknown option/missing source friendly errors;
- self-update tests are Pi-specific and not relevant to pi-crust extension framework yet.

pi-crust coverage now:

- install local package relative to isolated settings: `tests/integration/extension-install.test.ts`;
- remove with trailing slash/equivalent path: `tests/integration/extension-install.test.ts`.

Still relevant/not fully covered:

- actual CLI `pi-crust install` command does not exist yet;
- help/unknown-option/missing-source CLI tests should be added with CLI implementation.

### `packages/coding-agent/test/resource-loader.test.ts`

Relevant behaviors:

- resource loader starts empty before reload;
- reload discovers user/project resources;
- project resources override/prefer over user on collisions;
- symlinked user/project extensions load once;
- colliding commands from both extensions are retained and disambiguated;
- explicit CLI extensions prefer over discovered extensions on conflicts;
- conflict diagnostics.

pi-crust coverage now:

- duplicate command disambiguation: `tests/unit/extension-registry.test.ts`;
- package global/project dedupe with project winning: `tests/unit/extension-package-resolver.test.ts`.

Still relevant/not fully covered:

- no full pi-crust resource loader/reload exists yet;
- global/project/explicit extension discovery order not implemented yet;
- symlinked extension dirs need a dedicated test once discovery dirs exist.

### `packages/coding-agent/test/args.test.ts`

Relevant behaviors:

- `--extension` parses repeatable extension paths;
- `--no-extensions` disables discovery/loading;
- resource-related flags (`--skill`, `--theme`, etc.) are only relevant if pi-crust adds analogous resources.

pi-crust coverage now:

- none; CLI flags are future work.

Still relevant/not fully covered:

- `pi-crust --extension/-e ./extension`;
- `pi-crust --no-extensions`;
- env equivalents such as `PI_CRUST_EXTENSIONS` / `PI_CRUST_NO_EXTENSIONS`.

### `packages/coding-agent/test/test-harness.test.ts` and `test/suite/harness.ts`

Relevant behaviors:

- inline extension factories for deterministic tests;
- duplicate command disambiguation;
- fake/faux session/model runtime avoids API keys.

pi-crust coverage now:

- `tests/helpers/extension-harness.ts` provides inline extension factories;
- uses existing `MockPiAdapter` for HTTP/server E2E tests;
- duplicate command disambiguation covered.

Still relevant/not fully covered:

- browser/UI extension harness once web contributions render in React;
- golden install -> start server -> browser UI contribution test.

### Other Pi extension-related tests

- `agent-session-dynamic-tools.test.ts`: relevant by analogy for late/dynamic contribution registration after startup. pi-crust should add tests when extensions can reload or register after initial render.
- regressions `2835`, `3592`: Pi tool allowlist behavior is agent-tool-specific; relevant only if pi-crust introduces contribution allowlists/enablement filters.
- compaction/trigger-compact/model-extension/input-event tests: Pi-agent lifecycle-specific; mostly not relevant to pi-crust web/server extension framework except as examples for future event-bus tests.

## Newly added pi-crust tests in this worktree

- `tests/unit/extension-loader.test.ts` — dynamic import module shapes, bad module diagnostics, multiple manifest entries import/activation.
- `tests/unit/extension-registry.test.ts` — inline extension host, commands, slash names, duplicate commands, duplicate slash behavior, activity disposal, full host cleanup, partial activation cleanup, activation precedence, built-in activation parity, error isolation, server route dispatch.
- `tests/unit/extension-package-resolver.test.ts` — manifest resolution, fallback index behavior, non-extension ignores, no-extensions contract, missing explicit-path diagnostics, patterns, one-level discovery, directory pattern discovery, subdir manifest precedence, layered filters, force include/exclude, global/project dedupe, symlink dedupe.
- `tests/integration/extension-install.test.ts` — install, dedupe install, remove equivalent path, install -> resolve -> import -> activate -> run command.
- `tests/e2e/http-api-extension-route.test.ts` — real HTTP server serves extension routes mounted under `/api/extensions/:extensionId/*`, including extension registry metadata at `/api/extensions`, method isolation, decoded params, custom headers/status, and handler errors.
- `tests/unit/extension-bootstrap.test.ts` — config/env bootstrap loads explicit, project, global, and built-in extensions in precedence order; honors `PI_CRUST_EXTENSIONS` and `PI_CRUST_NO_EXTENSIONS`; reports explicit path diagnostics; resolves `PI_CRUST_CONFIG_DIR`.
- `tests/playwright/installed-extension-ui.spec.ts` — skipped north-star browser E2E for install -> UI contribution -> route -> command/session behavior.
