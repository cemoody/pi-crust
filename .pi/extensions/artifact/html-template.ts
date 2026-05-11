/**
 * Wraps a raw HTML/JS snippet into a self-contained document suitable for
 * rendering inside a sandboxed iframe.
 *
 * The wrapper:
 *  - sets a charset, removes default body margins, and applies a neutral font
 *    so the snippet looks consistent across viewers
 *  - never injects parent-page cookies, tokens, env vars, or globals
 *  - appends a tiny ResizeObserver-based size reporter that posts
 *    `{ type: "artifact:resize", height, artifactGroupId }` to window.parent
 *    whenever the body's scroll height changes, so the host can auto-fit the
 *    iframe without scrollbars
 *
 * The output is the full `<!doctype html>...</html>` string. It does NOT
 * sanitize the snippet — the iframe's `sandbox="allow-scripts"` attribute
 * (no `allow-same-origin`) is what isolates user-supplied JS from the host.
 */

export interface BuildHtmlDocumentOptions {
  /** The user-supplied HTML/JS body. Inserted verbatim inside <body>. */
  readonly body: string;
  /** Optional <title>; defaults to "artifact". */
  readonly title?: string;
  /** Used by the parent so a single page can host many iframes and route resize events. */
  readonly artifactGroupId: string;
}

export function buildHtmlDocument(options: BuildHtmlDocumentOptions): string {
  const title = escapeHtml(options.title ?? "artifact");
  const idAttr = escapeAttr(options.artifactGroupId);
  // Note: the resize script is intentionally tiny and uses no external deps.
  // It runs inside the sandboxed iframe; its postMessage target is window.parent.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; background: transparent; }
  body { padding: 12px; box-sizing: border-box; }
  *, *::before, *::after { box-sizing: border-box; }
</style>
</head>
<body data-artifact-group-id="${idAttr}">
${options.body}
<script>
(function(){
  var GROUP_ID = ${JSON.stringify(options.artifactGroupId)};
  var lastHeight = -1;
  function report(){
    try {
      var h = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight
      );
      if (h !== lastHeight) {
        lastHeight = h;
        window.parent.postMessage({ type: "artifact:resize", artifactGroupId: GROUP_ID, height: h }, "*");
      }
    } catch (e) { /* parent gone */ }
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(report).observe(document.body);
  }
  window.addEventListener("load", report);
  setTimeout(report, 0);
  setTimeout(report, 50);
  setTimeout(report, 200);
})();
</script>
</body>
</html>`;
}

const MAX_INLINE_HTML_BYTES = 64 * 1024;

export function shouldSpillHtmlToFile(html: string): boolean {
  return Buffer.byteLength(html, "utf8") > MAX_INLINE_HTML_BYTES;
}

export const HTML_INLINE_LIMIT_BYTES = MAX_INLINE_HTML_BYTES;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
