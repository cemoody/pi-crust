# Rich artifacts

pi-remote-control supports inline rendering of images, sandboxed HTML/D3
snippets, and declarative Vega-Lite / Plotly charts, surfaced via the
`display` tool provided by the bundled pi extension at
`.pi/extensions/artifact/`.

The design goal is a Jupyter/nteract-flavored notebook UX inside the web
client: the LLM produces a chart or image, calls one tool, and the result
appears in the message timeline as a first-class artifact — not buried inside
a tool card and not bloating the context window with base64 bytes.

## What the LLM can do

The extension registers a single tool, `display`. The LLM passes exactly one
of `path`, `html`, `vegaLite`, or `plotly`:

```python
# image (Phase A): save first, then display
fig.savefig("plots/revenue.png")
display(path="plots/revenue.png", caption="Q4 revenue by region")

# arbitrary HTML / D3 (Phase B): sandboxed iframe
display(html="""
  <svg width=300 height=200>...</svg>
  <script>/* arbitrary JS, runs with null origin */</script>
""", height=400)

# declarative chart (Phase C, preferred): no iframe, re-themable
display(vegaLite={
  "mark": "bar",
  "data": {"values": [{"a": "A", "b": 28}, {"a": "B", "b": 55}]},
  "encoding": {"x": {"field": "a"}, "y": {"field": "b", "type": "quantitative"}},
})

display(plotly={
  "data": [{"x": [1,2,3], "y": [1,4,9], "type": "scatter"}],
  "layout": {"title": "demo"},
})
```

The tool result the LLM sees back is always short (one line, e.g.
`"Displayed Vega-Lite chart (4.2 KB)."`). Rendered bytes never enter the
conversation context.

## Wire format

Artifacts ride inside a pi `CustomMessage`:

```ts
{
  role: "custom",
  customType: "artifact",
  content: "<text/plain fallback>",
  display: true,
  details: {
    version: 1,
    artifactGroupId: "<16 hex chars>",
    caption?: string,
    artifacts: [
      // One or more representations of the same logical artifact. The web
      // client picks the first MIME it recognizes; the last entry is always
      // a text/plain fallback so RPC/print clients degrade gracefully.
      { mime: "image/png", src: { kind: "url", url: "/api/sessions/.../artifacts/..." }, alt, bytes },
      { mime: "text/html", html: "<full document>" },
      { mime: "application/vnd.vega-lite.v5+json", spec: { ... } },
      { mime: "application/vnd.plotly.v1+json", figure: { ... } },
      { mime: "text/plain", text: "Image: chart.png (1.2 KB)" },
    ],
  },
}
```

The schema is versioned via `ARTIFACT_SCHEMA_VERSION` so future representation
shapes can ship without breaking sessions already on disk. The full type
definitions live in [`src/shared/artifact.ts`](../src/shared/artifact.ts).

## Storage layout

Artifact bytes are stored on disk under the project cwd:

```
<projectRoot>/.pi/artifacts/<sessionId>/<artifactId>.<ext>
```

- `sessionId` is the session-file basename (without `.jsonl`). The server can
  always derive a path from a session id without needing to consult the
  extension.
- `artifactId` is the first 16 hex chars of `sha256(bytes)`. Identical files
  dedupe automatically. Tests rely on this for stable fixtures.

## HTTP route

```
GET /api/sessions/:sessionId/artifacts/:filename
```

- Resolves to `<session.cwd>/.pi/artifacts/<sessionId>/<filename>`.
- realpath()s both the artifact root and the requested file, then asserts
  containment.
- Sets `Content-Type` from a small allowlist (image/*, text/html, text/plain,
  vega-lite+json, plotly+json, application/json) and falls back to
  `application/octet-stream` for anything else.
- Always sets `X-Content-Type-Options: nosniff`.
- For `text/html` responses, also sets
  `Content-Security-Policy: sandbox; default-src 'none'; …` as defense in
  depth on top of the iframe `sandbox=` attribute.

## Security model

- **Tool args never carry rendered bytes.** Images and large HTML snippets
  are read from disk (under cwd) or written there by the extension itself.
  This keeps JSONL and the LLM context lean.
- **HTML snippets run with null origin.** The iframe is
  `sandbox="allow-scripts"` only — no `allow-same-origin`, no
  `allow-top-navigation`, no `allow-forms`. The snippet cannot read host
  cookies, localStorage, or DOM.
- **Resize messages are double-filtered.** The web client only accepts
  `{type:"artifact:resize", artifactGroupId, height}` messages whose
  `event.source === iframe.contentWindow` AND whose group id matches this
  frame.
- **Path containment is enforced in two places.** The extension refuses to
  read source paths that resolve outside the project cwd. The HTTP route
  refuses to serve files that resolve outside `<cwd>/.pi/artifacts/<sid>/`.

## Size caps

| Limit | Default | Behavior |
|---|---|---|
| Per-artifact file | 25 MiB | Hard error to LLM (`size_cap`). Downscale and retry. |
| Inline HTML in wire | 64 KiB | Spills to artifact store; wire payload becomes `{src: {kind:"url", url}}`. |
| Inline spec in wire | 32 KiB | Spills to artifact store with `$ref` URL. |
| Spec absolute max | 256 KiB | Hard error to LLM. Trim before retrying. |

## Lifecycle

- Artifact custom messages persist in the session JSONL via
  `pi.sendMessage(...)`. They round-trip through session reload.
- On server startup, orphan artifact directories are GC'd: an artifact dir
  whose `<sessionId>.jsonl` is missing AND whose mtime is older than 7 days
  is removed. See [`src/server/artifact-gc.ts`](../src/server/artifact-gc.ts).

## Web rendering

The web client picks a representation in MIME priority order:

1. `application/vnd.vega-lite.v5+json` → lazy-loaded `react-vega`.
2. `application/vnd.plotly.v1+json` → lazy-loaded `react-plotly.js`.
3. `text/html` → sandboxed iframe (`HtmlArtifactFrame`).
4. `image/*` → `<img loading="lazy">`.
5. `text/plain` → `<pre>` fallback.

Vega-Lite and Plotly use `React.lazy` so neither bundle ships until the first
chart of that kind appears. The first render shows a "Loading <kind>…"
skeleton.

## Adding a new MIME

1. Add the new `*ArtifactRepresentation` variant to
   `src/shared/artifact.ts`. Keep `text/plain` as the always-present last
   entry in the wire envelope.
2. Add an entry to `ARTIFACT_MIME_EXTENSIONS` so the HTTP route can serve it
   with a correct `Content-Type`.
3. On the extension side, accept a new `display(...)` param (or extend an
   existing one) and emit the new representation. Don't forget to also emit
   a `text/plain` fallback.
4. On the web side, add a `mime →` case in
   `ArtifactView.tsx`. If your renderer is heavy, wrap it in
   `React.lazy(() => import("..."))` like Vega-Lite/Plotly so the main
   bundle stays small.
5. Add tests in `tests/unit/`: a shared-types test, an extension test,
   and a component test asserting the dispatch.

## Known deferred items

- **Caption editing** in the UI.
- **HTML/JSONL export support** for artifact messages (Phase 10 of
  `plan.md`).
- **Multimodal re-feed**: image artifacts are not currently re-ingested
  by the LLM during compaction; only the `text/plain` fallback survives.
  This is intentional for now.
- **Vega-Lite / Plotly theming** that re-renders on light/dark toggle. The
  components ship sensible defaults; full theme integration is a follow-up.
