# Editable presentation slides: TDD plan

## Goal

In the **Present deck** modal (the in-app fullscreen presenter), every text node
that was rendered from a known deck field becomes editable in-place. Edits are
debounced and persisted to disk under
`<session.cwd>/.pi/presentations/<sessionId>/<deckId>.deck.json` via the
`core.presentations` extension, so they survive page reloads and session
re-opens.

## Proposed user-facing behavior

1. Open a slide deck artifact card in the timeline.
2. Click **Present deck** → fullscreen modal opens (unchanged today).
3. Click **Edit** in the modal toolbar.
4. Double-click any title, subtitle, body, bullet, stat value/label, column
   text, fragment, or speaker note — start typing.
5. Edits appear immediately; 500 ms later they’re PATCHed to the server.
6. Close the modal → pending edits flush before the iframe is torn down.
7. Reload the page or re-open the session → edits are still there.

Slides whose body comes from a template-pack (`slide.html` / `slide.layout`)
are read-only and show an inline banner: *“Edit not supported for templated
slides.”*

## Deck identity

`PresentationDeck.id?: string` — added to the schema. When `show_presentation`
emits a deck without an id, the tool assigns a deterministic slug of the
title. The id is the filename component for persistence:
`<session.cwd>/.pi/presentations/<sessionId>/<deckId>.deck.json`.

## Editable JSON paths (allowlist)

Server-authoritative, frontend mirrors. RFC6902 JSON pointers, `replace` only,
string values only:

- `/title`, `/subtitle`, `/confidential`
- `/slides/:n/title|subtitle|eyebrow|body|quote|attribution|notes`
- `/slides/:n/bullets/:m` (string bullets) or `/slides/:n/bullets/:m/(text|detail)`
- `/slides/:n/stats/:m/(value|label)`
- `/slides/:n/columns/:m/(title|body)`
- `/slides/:n/columns/:m/bullets/:k` or `/slides/:n/columns/:m/bullets/:k/(text|detail)`
- `/slides/:n/fragments/:m`

**Not editable:** `/slides/:n/html`, `/slides/:n/layout`, `/slides/:n/slots`,
any `image.src`, `image.alt`, `logo`, `theme`, `templatePack`.

## On-disk format

`<deckId>.deck.json`:

```json
{
  "version": 1,
  "deckId": "executive-signal-brief",
  "updatedAt": 1700000005000,
  "deck": { /* PresentationDeck */ }
}
```

Writes are atomic: `<deckId>.deck.json.tmp` → `rename()`. An in-memory mutex
serializes concurrent writes per `(sessionId, deckId)`.

## HTTP surface (new routes in `extensions/presentations/server.mjs`)

| Method | Path                                                                | Behavior                                    |
| ------ | ------------------------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/sessions/:sessionId/presentations/:deckId/deck.json`          | 200 with envelope or 404 if no edits yet    |
| PUT    | `/api/sessions/:sessionId/presentations/:deckId/deck.json`          | replace full deck (validated)               |
| PATCH  | `/api/sessions/:sessionId/presentations/:deckId/deck.json`          | `{ ops: [{op:"replace", path, value}] }`    |

All paths reuse the existing `isSafeFileSegment` for `deckId`; PATCH validates
each op against the allowlist and re-runs `validatePresentationDeck` before
writing.

## Frontend wiring

`compileRevealHtml(deck, { editable: true })`:

- Adds `data-deck-path="<json-pointer>"` to every editable element.
- Adds `contenteditable="plaintext-only"` to those elements.
- Adds a wrapper script that `postMessage`s
  `{ type: "pi-deck-edit", path, value, deckId }` to `window.parent` on `input`.
- Adds a one-line CSS rule highlighting `[contenteditable]:focus`.

`PresentationArtifactCard`:

- On mount, fetches the persisted deck (404 → fall back to `deckInput`).
- Adds **Edit** toggle inside the modal toolbar.
- Listens for `pi-deck-edit` messages, applies them locally (optimistic),
  debounces 500 ms, then PATCHes the server. Coalesces multiple edits in the
  same window into a single PATCH batch.
- Flushes pending edits on modal close.
- On 4xx/5xx PATCH responses, rolls the optimistic state back to the last
  server-confirmed deck and shows a non-blocking inline error.

## TDD files (this commit lands all of them, all red)

### Unit (vitest)

- `tests/unit/presentation-deck-patch.test.ts` — pure `applyDeckPatch()` + allowlist
- `tests/unit/presentation-editable-compile.test.ts` — `compileRevealHtml(..., { editable: true })`
- `tests/unit/presentations-server-edit-routes.test.ts` — GET/PUT/PATCH `<deckId>.deck.json`
- `tests/unit/presentation-editable-card.test.tsx` — React card behavior in edit mode
- `tests/unit/pi-presentation-tool-deckid.test.ts` — `show_presentation` assigns stable id

### Playwright (e2e)

- `tests/playwright/presentation-editable.spec.ts` — full end-to-end edit → persist → reload flow

## Out of scope (v1)

- Multi-line / rich-text editing (we use `contenteditable="plaintext-only"`).
- Reordering slides, adding/removing slides/bullets.
- Inline image edits (replace, crop).
- Multi-user conflict resolution beyond last-write-wins. (No `If-Match` flow.)
- Edits to template-pack `slide.html` output.

## Open questions

1. Should `show_presentation` write an initial `<deckId>.deck.json` on every
   tool call, or wait until the user makes the first edit? Current plan: wait
   until first edit (lazy create on PATCH).
2. Should the **Edit** button appear in the small preview iframe too, or only
   in the fullscreen modal? Current plan: modal only — preview is read-only.
3. Authorization: writes happen on loopback only today; should we add a
   session-token check on PUT/PATCH? Current plan: defer to follow-up.
