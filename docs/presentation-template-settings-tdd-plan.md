# Presentation template settings: TDD plan

## Goal

Keep slide decks as inline conversation artifacts, but let `core.presentations` configure reusable template packs from pi-crust Settings. The first implementation should add a **Presentations** section in Settings where users can add one or more local template directories, choose a default template pack/theme, validate templates, and reload template metadata without adding a new sidebar activity.

## Proposed user-facing behavior

1. Open **Settings**.
2. See a **Presentations** section contributed by `core.presentations`.
3. Add a local template directory, for example:
   - `extensions/presentations/templates/builtin`
   - `/path/to/private/presentation_templates`
4. Click **Validate templates**.
5. See discovered template packs, layouts, themes, example decks, and diagnostics.
6. Choose defaults:
   - default template pack
   - default theme
   - optional brand/assets directory
7. Ask Pi to create a deck; `show_presentation` can use configured pack IDs and layout names.

## Proposed on-disk template pack format

```text
template-pack/
  template-pack.json
  layouts/
    title.json
    image-bullets.json
    bullets.json
  themes/
    light.json
    light.css
  assets/
    sample-plot.svg
  examples/
    title.deck.json
    image-bullets.deck.json
    bullets.deck.json
```

`template-pack.json` should be intentionally simple and stable:

```json
{
  "id": "builtin-presentations",
  "name": "Built-in presentation templates",
  "version": "0.1.0",
  "layouts": ["title", "image-bullets", "bullets"],
  "themes": ["light"],
  "examples": ["title.deck.json", "image-bullets.deck.json", "bullets.deck.json"]
}
```

## Test-first implementation checklist

### 1. Extension settings contribution registry

Add tests before implementation:

- `extension-registry.test.ts`
  - extension can register a settings section with id/title/order;
  - duplicate settings section ids fail with diagnostics;
  - settings sections are disposed on reload;
  - `/api/extensions` exposes settings section metadata and web module asset URL;
  - disabled extension removes contributed settings section.

Expected API sketch:

```ts
prc.settings.registerSection({
  id: "core.presentations.settings",
  title: "Presentations",
  order: 50,
});
```

### 2. Settings UI host

Add tests before implementation:

- `settings-extension-section.test.tsx`
  - Settings modal renders extension-contributed sections;
  - clicking **Presentations** loads its web module;
  - web module receives host React, `api.request`, and current settings;
  - failing module shows safe error UI and does not break other settings.

### 3. Presentation settings persistence routes

Add tests before implementation:

- `presentations-settings-server.test.ts`
  - `GET /api/presentations/settings` returns defaults;
  - `POST /api/presentations/settings` persists template dirs/defaults;
  - invalid JSON/path values return 400;
  - settings survive runtime reload;
  - disabling `core.presentations` removes the routes.

Proposed data shape:

```json
{
  "templateDirs": ["/abs/path/to/template-pack"],
  "defaultTemplatePack": "builtin-presentations",
  "defaultTheme": "light"
}
```

### 4. Template discovery and validation

Add tests before implementation:

- `presentation-template-discovery.test.ts`
  - discovers `template-pack.json` in configured dirs;
  - validates required `id`, `name`, `version`, `layouts`;
  - loads layout metadata from `layouts/*.json`;
  - loads theme metadata/assets only from safe paths;
  - reports duplicate pack IDs as diagnostics;
  - reports missing layouts/examples without crashing;
  - rejects path traversal and unsafe extensions.

### 5. Tool/template integration

Add tests before implementation:

- `pi-presentation-tool.test.ts`
  - `show_presentation` accepts `templatePack`, `theme`, and layout names;
  - unavailable template pack returns a clear tool error;
  - `list_presentation_templates` returns configured packs/layouts;
  - prompt guidance includes available pack/layout summaries without dumping huge JSON.

### 6. End-to-end Settings flow

Add Playwright tests before implementation:

- `presentation-template-settings.spec.ts`
  - open Settings;
  - Presentations section appears only when `core.presentations` is enabled;
  - add a temp template directory;
  - validate/reload templates;
  - select default pack/theme;
  - create/render seeded deck using that pack;
  - disable extension and verify settings section disappears but existing artifacts fall back safely.

### 7. Private template pack visual fixture harness

Add Playwright tests before implementation:

- render representative examples from a private slide-template PDF or template pack;
- capture fixture screenshots for title, image+bullets, bullets, quote, metric, team-grid;
- compare later with a loose visual threshold or keep screenshot artifacts as manual review gates until the private template pack is mature.

## Initial non-goals

- No PowerPoint export in this phase.
- No full private company template translation in this phase.
- No template editor UI in this phase.
- No arbitrary third-party JavaScript in template packs; templates are JSON/CSS/assets consumed by the trusted presentation compiler.
