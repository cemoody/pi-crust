# pi-crust — Rich Artifacts Plan

Add a "scientific notebook" rendering layer to pi-crust so the LLM can return
**inline images, sandboxed HTML/D3 snippets, and declarative Vega-Lite/Plotly charts**
alongside text. Implemented as a pi extension plus a small web-side renderer registry,
with bytes served out-of-band over HTTP.

This plan implements the recommended combo from the design exploration:
**Option 2 (custom message) + Option 3 (multi-MIME envelope) + Option 4 (HTTP artifact store) + Option 5 (sandboxed iframe) + Option 6 (declarative viz)**.

## Guiding principles

- **No fork of pi.** Everything lives in a project-local pi extension (`.pi/extensions/artifact/`) plus the existing pi-crust server + web client.
- **No protocol version bump.** Artifacts ride inside the already-opaque `WireMessage.content` / `details` payloads. Add a `customType` and a MIME envelope, nothing else.
- **Tool args/results stay tiny.** Bytes never go on the wire as base64-in-args. The LLM passes file paths or specs; the extension materializes bytes and writes them to a per-session artifact dir.
- **Artifacts are first-class messages**, not nested inside a tool card. Emitted via `pi.sendMessage({ customType: "artifact", ... })` so they appear in the timeline like assistant messages, survive `/tree`, and persist in JSONL.
- **Multi-representation with fallback.** Every artifact carries at minimum a `text/plain` representation. RPC/JSON/low-bandwidth clients degrade gracefully.
- **Untrusted HTML is sandboxed.** `text/html` always renders in `<iframe sandbox="allow-scripts" srcdoc={…}>` — never `allow-same-origin`. The control plane is never reachable from artifact JS.
- **Test-first.** Reducer/renderer changes have unit tests against fixture events before any UI work.

## Architectural target

```text
LLM
  │ tool_call: display(path=…, html=…, vegaLite=…, …)
  ▼
pi extension  (.pi/extensions/artifact/)
  ├─ materialize bytes → .pi/artifacts/<sessionId>/<artifactId>.<ext>
  ├─ pi.sendMessage({ customType: "artifact", details: { artifacts:[…] }})
  └─ return short text result to LLM ("Displayed image/png.")
       │
       ▼
pi-crust server
  ├─ forwards session_event → WebSocket (already works, no changes)
  └─ NEW: GET /artifacts/:sessionId/:artifactId   (auth-gated, allowlisted)
       │
       ▼
Web client
  ├─ reducer: store artifact messages by id
  ├─ ArtifactMessage renderer (dispatches on customType)
  └─ ArtifactView (dispatches on artifact[].mime)
       ├─ image/*           → <img src=url>
       ├─ text/html         → <iframe sandbox="allow-scripts" srcdoc=…>
       ├─ image/svg+xml     → sanitized inline SVG (or iframe)
       ├─ vega-lite+json    → react-vega
       ├─ plotly.v1+json    → react-plotly.js
       └─ fallback          → text/plain or pretty JSON
```

## Shared data shapes

Defined once in `src/shared/artifact.ts` and imported by both the extension (via a small types-only re-export package or a copied .d.ts) and the web client.

```ts
export interface ArtifactMessageDetails {
  artifacts: readonly ArtifactRepresentation[];
  caption?: string;
  artifactGroupId: string;   // stable id; used as React key + HTTP path
}

export type ArtifactRepresentation =
  | { mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      src: { kind: "url"; url: string } | { kind: "dataUrl"; dataUrl: string };
      width?: number; height?: number; alt?: string }
  | { mime: "image/svg+xml";
      src: { kind: "url"; url: string } | { kind: "inline"; svg: string } }
  | { mime: "text/html";
      html: string;
      height?: number;          // initial iframe height in px; auto-resizes via postMessage
      allowScripts?: boolean }   // default true
  | { mime: "application/vnd.vega-lite.v5+json"; spec: unknown }
  | { mime: "application/vnd.plotly.v1+json"; figure: unknown }
  | { mime: "text/plain"; text: string };               // fallback, always present
```

`customType` for the carrier message: `"artifact"` (constant exported from shared module).

---

# Phase A — Extension skeleton + image path support

## Goal

A working `display(path=…)` tool that puts a PNG into the timeline as a custom message,
served out-of-band over HTTP, with a basic web renderer.

## Todo

- [ ] Create `.pi/extensions/artifact/` directory with `package.json`, `index.ts`, `artifactStore.ts`.
- [ ] Implement `ArtifactStore`:
  - [ ] resolves `.pi/artifacts/<sessionId>/` directory (creates on demand)
  - [ ] `put(sessionId, sourcePath | bytes, mime) → { artifactId, url, diskPath }`
  - [ ] cleanup hook on `session_shutdown` for ephemeral sessions
  - [ ] size cap per artifact (default 25 MB) with clear error
- [ ] Register tool `display`:
  - [ ] params: `{ path?, caption?, mimeHint? }` (Phase A only handles `path` → image/*)
  - [ ] reads file, detects MIME from extension/magic bytes
  - [ ] stores via `ArtifactStore`
  - [ ] always builds a `text/plain` fallback (`"Image: <basename> (<W>x<H>, <bytes> bytes)"`) — use `image-size` for dimensions
  - [ ] calls `pi.sendMessage({ customType: "artifact", display: true, details })`
  - [ ] returns `{ content: [{type:"text", text:"Displayed <mime>."}], details: { artifactGroupId } }`
- [ ] Tool guidelines (`promptGuidelines`):
  - [ ] "Call display(path=...) immediately after saving a plot or chart so the user sees it inline."
  - [ ] "Do not base64-encode images in tool arguments. Save to a file first, then call display(path=…)."
- [ ] Add HTTP route in `src/server/http-api-server.ts`:
  - [ ] `GET /artifacts/:sessionId/:artifactId`
  - [ ] auth: same app token as WebSocket (Phase 12 token)
  - [ ] path allowlist: must resolve inside `.pi/artifacts/<sessionId>/` for a session the requester is authorized on
  - [ ] sets `Content-Type`, `Cache-Control: private, max-age=3600`, `ETag`
- [ ] Web client:
  - [ ] add `customType` dispatch table to the timeline message renderer
  - [ ] `ArtifactMessage` component (caption + `<ArtifactView />`)
  - [ ] `ArtifactView` Phase A: handle `image/png|jpeg|webp|gif` only; fallback shows `text/plain`
  - [ ] respect low-bandwidth mode (lazy `<img loading="lazy">`, hide until tapped)
- [ ] Reducer: store `customType === "artifact"` messages in the message list; do not collapse with adjacent assistant text.

## TDD-style tests

- [ ] `ArtifactStore.put` writes file under `.pi/artifacts/<sessionId>/` and returns a stable id.
- [ ] `ArtifactStore.put` rejects paths outside cwd and writes over symlinks.
- [ ] `ArtifactStore.put` enforces size cap and returns typed error.
- [ ] `display` tool with a PNG fixture emits one `customMessage` event with `customType: "artifact"`.
- [ ] Emitted artifact has both `image/png` and `text/plain` representations.
- [ ] Tool result `content` is a short text string (no base64).
- [ ] HTTP route serves file with correct MIME and 200.
- [ ] HTTP route rejects unauthorized token with 401.
- [ ] HTTP route rejects path traversal (`../`, absolute, symlink-escape) with 403.
- [ ] HTTP route rejects request for an artifact belonging to a different session with 403.
- [ ] Web reducer creates an artifact message node from the fixture event.
- [ ] `ArtifactView` renders `<img>` with the artifact URL.
- [ ] Low-bandwidth mode renders placeholder until tap-to-load.

---

# Phase B — HTML / D3 via sandboxed iframe

## Goal

LLM can return arbitrary HTML snippets (including D3) that render interactively in the
timeline without compromising the host page.

## Todo

- [ ] Extend `display` tool params with `{ html?: string, height?: number }`.
- [ ] Extension builds a `text/html` representation:
  - [ ] wraps the snippet in a minimal page template (`<!doctype html><meta charset=…><style>body{margin:0;font:…}</style>…`)
  - [ ] **never** injects parent-page cookies, tokens, or env values
  - [ ] appends a tiny postMessage size-reporter script so the iframe can self-size
  - [ ] also generates a `text/plain` fallback (first 200 chars of stripped text content, or caption)
- [ ] If snippet is > 64 KB, store as a file in `ArtifactStore` and emit `{mime:"text/html", src:{kind:"url",url}}` instead of inline html — same iframe rendering path on the web side.
- [ ] HTTP route already handles arbitrary MIME, but verify `Content-Security-Policy: sandbox` header is set on `text/html` responses (defense in depth).
- [ ] Web client:
  - [ ] `HtmlArtifactFrame` component
  - [ ] `<iframe sandbox="allow-scripts" srcdoc={html}>` — **no `allow-same-origin`, no `allow-top-navigation`, no `allow-forms`**
  - [ ] listens for `postMessage({type:"artifact:resize", height})` from iframe, clamps to `[min, maxViewportHeight]`
  - [ ] "Open fullscreen" button → modal with the same iframe at viewport size
  - [ ] graceful fallback when scripts are disabled (show captured `text/plain`)
- [ ] Add a curated D3 example fixture to confirm the render path end-to-end.

## TDD-style tests

- [ ] `display(html=…)` emits an artifact with a `text/html` and `text/plain` representation.
- [ ] HTML > 64 KB threshold goes via URL, not inline.
- [ ] Iframe element has exactly `sandbox="allow-scripts"` — no `allow-same-origin`.
- [ ] Snapshot test: HTML response includes `Content-Security-Policy: sandbox`.
- [ ] `postMessage` resize event updates iframe height; clamping is respected.
- [ ] Cross-origin script in snippet cannot read `document.cookie` of host (jsdom XSS test).
- [ ] Fullscreen modal opens with same content and closes cleanly.

---

# Phase C — Declarative viz: Vega-Lite + Plotly

## Goal

Preferred path for charts: the LLM emits a JSON spec, the web client renders it natively
(no iframe, no XSS surface, theming honoured).

## Todo

- [ ] Add `vegaLite?: object` and `plotly?: object` params to `display` tool.
- [ ] Extension validates shape minimally (must be a plain object; size cap 256 KB) and emits the corresponding MIME representation; always also emit `text/plain` fallback (caption or "Vega-Lite chart").
- [ ] Add web deps: `react-vega` (+ `vega`, `vega-lite`), `react-plotly.js` (+ `plotly.js-dist-min`). Lazy-load both via dynamic `import()` so the main bundle isn't bloated; show a skeleton until loaded.
- [ ] `VegaLiteArtifact` component — applies current theme palette as default config (light/dark from Phase 8 theme).
- [ ] `PlotlyArtifact` component — same theming hook.
- [ ] Add prompt guideline: "Prefer display(vegaLite=…) over display(html=…) for charts. Prefer display(plotly=…) only when interactive 3D or specialized traces are needed."
- [ ] Update server export-to-HTML to inline these specs (Phase 10 export still produces a self-contained file).

## TDD-style tests

- [ ] `display(vegaLite={…})` emits artifact with `application/vnd.vega-lite.v5+json` and `text/plain` reps.
- [ ] `display(plotly={…})` emits artifact with `application/vnd.plotly.v1+json` and `text/plain` reps.
- [ ] Oversize spec (> 256 KB) returns typed error from tool.
- [ ] `VegaLiteArtifact` renders a fixture spec to a non-empty SVG/canvas in jsdom.
- [ ] Theme change re-renders chart with new palette.
- [ ] Dynamic import is invoked only when first chart appears (bundle-size guard).

---

# Phase D — Polish, lifecycle, export

## Goal

Make artifacts feel like a first-class part of the session: persist, export, clean up,
copy/save, low-bandwidth-friendly.

## Todo

- [ ] **Persistence audit:** confirm artifact custom messages round-trip through session JSONL and reload correctly via `session_start` reason `"resume"`.
- [ ] **Resume hydration:** on session open, server scans `.pi/artifacts/<sessionId>/` and reconciles against artifact messages; orphan files are GC'd after grace period (default 7 days).
- [ ] **Deletion:** deleting a session via the dashboard removes the artifact dir too (with confirmation already in Phase 3).
- [ ] **Per-artifact actions** in the UI: copy image, download (`<a download>` for URL artifacts), open raw, "copy as link".
- [ ] **Caption editing** — optional, stored as a label-like edit on the customMessage.
- [ ] **Low-bandwidth mode** (Phase 12): artifacts collapsed to a placeholder card with size + MIME until tapped. Charts not rendered until expanded.
- [ ] **HTML export** (`/export`, Phase 10):
  - [ ] image/* → inline as `<img src="data:…">` (size-capped) or copy alongside the HTML
  - [ ] text/html → embedded sandboxed iframe with `srcdoc`
  - [ ] vega-lite/plotly → embed lib via CDN script tag + JSON spec
- [ ] **JSONL export**: artifact dir is included as a sibling tarball, or referenced URLs are rewritten to relative paths.
- [ ] **RPC mode**: artifact messages flow through unchanged; document that RPC clients should consume the `text/plain` fallback.
- [ ] **Print/JSON mode**: prints `text/plain` representation.
- [ ] **Docs**: add `docs/artifacts.md` covering the data shape, the tool API, and how to author new MIME renderers.

## TDD-style tests

- [ ] Artifact message survives session reload (`getEntries()` still includes it).
- [ ] Orphan-file GC removes files older than retention with no matching message.
- [ ] Deleting a session removes its artifact dir.
- [ ] Download button produces correct filename + bytes for each MIME.
- [ ] Low-bandwidth fixture renders placeholders for all artifact types.
- [ ] HTML export contains rendered `<img>` / `<iframe>` / Vega-Lite script tag for fixtures.
- [ ] Print/`-p` mode emits the `text/plain` fallback for an artifact-bearing session.

---

# Cross-cutting requirements

- **Auth**: artifact HTTP route uses the same app token (cookie or `Authorization: Bearer`) as the WebSocket. Reject anonymous.
- **Path safety**: every filesystem read in the extension and server must `realpath()` and assert containment in `.pi/artifacts/<sessionId>/` (or for `display(path=…)`, inside the session's cwd allowlist).
- **MIME safety**: never echo a client-supplied MIME into a `Content-Type` header without allowlisting (`image/*`, `text/html`, `image/svg+xml`, `application/json`). Anything else → `application/octet-stream` + `Content-Disposition: attachment`.
- **CSP**: HTML artifact responses ship `Content-Security-Policy: sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'`. The iframe's `sandbox=` attr is the primary defense; CSP is belt-and-braces.
- **Size caps**: 25 MB per artifact file, 64 KB for inline HTML, 256 KB for inline Vega-Lite/Plotly specs. All configurable in `settings.json` under `artifact.limits`.
- **Backpressure**: a single tool call must not emit more than N (default 16) artifacts in one shot; further calls return a typed error to the LLM.
- **Determinism for tests**: artifact ids are `<sha256(bytes)>.slice(0,16)` so fixtures are stable; the extension exposes a clock/uuid injection seam.

# Risks

| Risk | Mitigation |
|------|------------|
| LLM still tries to base64 plots into args | Strong `promptGuidelines`, plus the tool **rejects** any param > 64 KB and tells the model to write to a file first. |
| Sandbox bypass via iframe | Drop `allow-same-origin` permanently. Serve HTML from a different origin if/when one is available (subdomain `artifacts.<host>`). |
| Disk fills up with old artifacts | Default 7-day GC, configurable; admin status page shows total artifact disk usage. |
| Vega/Plotly bundle bloat | Dynamic `import()` only when first chart is rendered. Both libs gzip well; budget ~300 KB lazy. |
| Session JSONL grows large with embedded specs | Specs > 32 KB are spilled to file via `ArtifactStore`, message keeps only the URL. |
| Image dimensions unknown for `text/plain` fallback | Use `image-size` (tiny, sync) at extension time. |

# Open questions

- [ ] Should `display` be a single tool with mutually-exclusive params, or split into `display_image` / `display_html` / `display_chart`? (Lean: single tool, clearer to the LLM.)
- [ ] Should artifacts ever be re-fed to the LLM (multimodal)? E.g., on `/compact` should image artifacts be summarized? Initial answer: no — keep them user-only, summarize via the `text/plain` fallback.
- [ ] Do we want a `display(latex=…)` MIME from day one or defer? (Defer to a Phase E.)
- [ ] Should the extension be shipped as a pi package (`pi install npm:@…/pi-artifacts`) once stable, so it can be reused outside this repo? (Yes, after Phase C lands.)

# Out of scope

- LLM consuming user-uploaded images (multimodal input is already handled in Phase 6).
- Editing artifacts after creation (caption edit only).
- Server-side rendering of Vega-Lite/Plotly to PNG (could be a later optimization).
- LaTeX/MathJax — defer.
- Audio/video artifacts — defer.

# Suggested implementation order

1. Phase A end-to-end (image path → HTTP → web `<img>`). Smallest useful slice; ~1 day of focused work.
2. Phase B (HTML/D3 iframe). Unlocks the "interactive notebook" vibe.
3. Phase C (Vega-Lite, then Plotly). Becomes the recommended chart path.
4. Phase D polish, export, lifecycle.
