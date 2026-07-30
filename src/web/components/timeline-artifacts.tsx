/**
 * Artifact rendering and download handling for the message timeline.
 *
 * Kept separate from MessageTimeline so the scrolling/virtualization container
 * remains concerned only with transcript layout while this module owns the
 * varied artifact formats, lazy hydration, and editable markdown workflow.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PRESENTATION_MIME } from "../../presentations/schema.js";
import { slugify } from "../../shared/util.js";
import { coerceMarkdownInput } from "../utils/safe-markdown.js";
import { Icon } from "./Icon.js";
import { useOptionalNotifications } from "./notifications.js";
import { PresentationArtifactCard } from "./presentation-artifact-card.js";
import { PrStoryArtifactCard } from "./pr-story-artifact-card.js";

// Lazy-loaded so vega/vega-lite (~600KB gzipped) is only fetched once a chart
// actually appears in the timeline. The placeholder shell is rendered
// synchronously so tests and screen readers see the artifact even before the
// chart paints.
const LazyVegaLiteChart = lazy(() => import("./VegaLiteChart.js"));

export const VEGA_LITE_MIME = "application/vnd.vega-lite.v5+json";

export interface TimelineArtifactRepresentation {
  readonly mime: string;
  readonly text?: string;
  readonly html?: string;
  readonly spec?: unknown;
  readonly data?: unknown;
  readonly figure?: unknown;
  readonly src?: { readonly kind: "url"; readonly url: string } | { readonly kind: "inline"; readonly svg: string };
  readonly alt?: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface TimelineArtifactDetails {
  readonly version?: number;
  readonly artifactGroupId: string;
  readonly artifacts: readonly TimelineArtifactRepresentation[];
  readonly caption?: string;
}

export interface TimelineArtifact {
  readonly version?: number;
  readonly kind: "image" | "html" | "markdown" | "json" | "table" | "vega-lite" | "presentation" | string;
  readonly title?: string;
  readonly path?: string;
  readonly url?: string;
  readonly mimeType?: string;
  readonly html?: string;
  readonly markdown?: string;
  readonly data?: unknown;
  readonly alt?: string;
  readonly artifactUrl?: string;
  readonly artifactTruncated?: boolean;
  readonly artifactFullBytes?: number;
}

/** Resolve an artifact `path`/`url` into a fetchable href, prefixing the
 *  configured API base for same-origin `/api/...` routes. */
function resolveArtifactSrc(src: string | undefined): string | undefined {
  if (typeof src !== "string" || src.length === 0) return undefined;
  const base = import.meta.env.VITE_PI_CRUST_API_BASE ?? "";
  return src.startsWith("/api/") ? `${base}${src}` : src;
}

/** Basename of a path/url (query string stripped), or undefined when empty. */
export function artifactBasename(candidate: string | undefined): string | undefined {
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  const withoutQuery = candidate.split(/[?#]/)[0] ?? candidate;
  const base = withoutQuery.split(/[\\/]/).pop();
  return base && base.length > 0 ? base : undefined;
}

/**
 * Computes a `{ href, name }` download target for any artifact kind. Inline
 * artifacts (html/markdown/json/table/vega-lite) become client-side blobs;
 * file-backed artifacts (image, or html/data with a `path`/`url`) download
 * straight from their served source. Returns null when there is nothing to
 * download. Manages the blob object-URL lifecycle so it is revoked on unmount.
 */
function useArtifactDownload(
  artifact: TimelineArtifact,
  title: string,
): { readonly href: string; readonly name: string } | null {
  const blob = useMemo(() => {
    if (artifact.kind === "html" && typeof artifact.html === "string") {
      return { data: artifact.html, type: "text/html", ext: "html" };
    }
    if (artifact.kind === "markdown" && typeof artifact.markdown === "string") {
      return { data: artifact.markdown, type: "text/markdown", ext: "md" };
    }
    if (
      artifact.data !== undefined &&
      (artifact.kind === "json" || artifact.kind === "table" || artifact.kind === "vega-lite")
    ) {
      return { data: JSON.stringify(artifact.data, null, 2), type: "application/json", ext: "json" };
    }
    return null;
  }, [artifact.kind, artifact.html, artifact.markdown, artifact.data]);

  const objectUrl = useMemo(
    () => (blob ? URL.createObjectURL(new Blob([blob.data], { type: blob.type })) : null),
    [blob],
  );
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  if (objectUrl && blob) {
    const name = artifactBasename(artifact.path) ?? `${slugify(title, "artifact")}.${blob.ext}`;
    return { href: objectUrl, name };
  }
  const src = resolveArtifactSrc(artifact.url ?? artifact.path);
  if (src) {
    return { href: src, name: artifactBasename(artifact.path ?? artifact.url) ?? slugify(title, "artifact") };
  }
  return null;
}

/** Small download control shared across artifact previews; renders nothing
 *  when the artifact has no downloadable content. */
function ArtifactDownloadButton({ artifact, title }: { readonly artifact: TimelineArtifact; readonly title: string }) {
  const download = useArtifactDownload(artifact, title);
  if (!download) return null;
  return (
    <a
      className="artifact-markdown-action artifact-download-action"
      href={download.href}
      download={download.name}
      aria-label="Download artifact"
      title={`Download ${download.name}`}
    >
      <Icon name="download" />
    </a>
  );
}

/** Header row (title + download button) shared by non-markdown previews. */
function ArtifactPreviewHeader({ artifact, title }: { readonly artifact: TimelineArtifact; readonly title: string }) {
  return (
    <div className="artifact-preview-header">
      <strong>{title}</strong>
      <div className="artifact-markdown-actions">
        <ArtifactDownloadButton artifact={artifact} title={title} />
      </div>
    </div>
  );
}

export function ArtifactPreview({ artifact }: { readonly artifact: TimelineArtifact }) {
  const title = artifact.title ?? `${artifact.kind} artifact`;
  if (artifact.artifactUrl && artifact.artifactTruncated) {
    return <LazyToolArtifactPreview artifact={artifact} title={title} />;
  }
  if (artifact.kind === "image") {
    const src = artifact.url ?? artifact.path;
    return src ? (
      <figure className="artifact-preview artifact-image">
        <ArtifactPreviewHeader artifact={artifact} title={title} />
        <img src={src} alt={artifact.alt ?? title} />
      </figure>
    ) : <ArtifactFallback artifact={artifact} />;
  }
  if (artifact.kind === "html") {
    // Inline HTML renders via srcDoc; a file-backed artifact (path/url with no
    // inline `html`) renders via src pointing at the artifact-file route. In
    // both cases the iframe is sandboxed WITHOUT allow-same-origin so artifact
    // HTML can never read the host app's cookies/DOM. (`allow-scripts` lets
    // interactive content — e.g. embedded plots — run inside the opaque origin.)
    if (typeof artifact.html === "string") {
      return (
        <figure className="artifact-preview artifact-html">
          <ArtifactPreviewHeader artifact={artifact} title={title} />
          <iframe title={title} className="artifact-html" sandbox="" srcDoc={artifact.html} />
        </figure>
      );
    }
    const src = artifact.url ?? artifact.path;
    if (typeof src === "string" && src.length > 0) {
      const resolved = resolveArtifactSrc(src)!;
      return (
        <figure className="artifact-preview artifact-html">
          <ArtifactPreviewHeader artifact={artifact} title={title} />
          <iframe title={title} className="artifact-html" sandbox="allow-scripts" src={resolved} />
        </figure>
      );
    }
  }
  if (artifact.kind === "markdown" && typeof artifact.markdown === "string") {
    return <MarkdownArtifact artifact={artifact} title={title} />;
  }
  if (artifact.kind === "presentation" && artifact.data) {
    return <PresentationArtifactCard deckInput={artifact.data} title={title} />;
  }
  if (artifact.kind === "pr-story" && artifact.data) {
    return <PrStoryArtifactCard storyInput={artifact.data} />;
  }
  return <ArtifactFallback artifact={artifact} />;
}

/**
 * Renders a `kind: "markdown"` artifact with inline view / edit / download
 * controls. When the artifact carries a backing on-disk `path`, the pencil
 * toggles an inline editor whose Save button writes the new content straight
 * back to that file via `PUT /api/artifact-file`. The download button always
 * works (client-side blob), even for inline-only markdown with no file path.
 */
function MarkdownArtifact({ artifact, title }: { readonly artifact: TimelineArtifact; readonly title: string }) {
  const initial = typeof artifact.markdown === "string" ? artifact.markdown : "";
  const [content, setContent] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notifications = useOptionalNotifications();

  // If the artifact prop changes underneath us (e.g. a lazy fetch resolved or
  // a new tool result arrived), resync the displayed content while we're not
  // mid-edit so we never show stale text.
  useEffect(() => {
    if (!editing) {
      setContent(initial);
      setDraft(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const canSave = typeof artifact.path === "string" && artifact.path.length > 0;
  const downloadName = useMemo(() => markdownDownloadName(artifact.path, title), [artifact.path, title]);
  const downloadUrl = useMemo(
    () => URL.createObjectURL(new Blob([content], { type: "text/markdown" })),
    [content],
  );
  useEffect(() => () => URL.revokeObjectURL(downloadUrl), [downloadUrl]);

  const beginEdit = () => {
    setDraft(content);
    setError(null);
    setEditing(true);
  };
  const cancelEdit = () => {
    setDraft(content);
    setError(null);
    setEditing(false);
  };
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const base = import.meta.env.VITE_PI_CRUST_API_BASE ?? "";
      const url = `${base}/api/artifact-file?path=${encodeURIComponent(artifact.path as string)}`;
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error ?? `Save failed (${response.status})`);
      }
      setContent(draft);
      setEditing(false);
      notifications?.notify({ kind: "success", message: `Saved ${downloadName}` });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      notifications?.notify({ kind: "error", message: `Could not save: ${message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="artifact-preview artifact-markdown" aria-label={title}>
      <div className="artifact-markdown-header">
        <strong>{title}</strong>
        <div className="artifact-markdown-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="artifact-markdown-action"
                onClick={save}
                disabled={saving || !canSave}
                aria-label="Save changes"
                title={canSave ? "Save changes to file" : "No backing file to save to"}
              >
                <Icon name="check" />
              </button>
              <button
                type="button"
                className="artifact-markdown-action"
                onClick={cancelEdit}
                disabled={saving}
                aria-label="Cancel editing"
                title="Cancel"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {canSave ? (
                <button
                  type="button"
                  className="artifact-markdown-action"
                  onClick={beginEdit}
                  aria-label="Edit markdown"
                  title="Edit"
                >
                  <Icon name="pencil" />
                </button>
              ) : null}
              <a
                className="artifact-markdown-action"
                href={downloadUrl}
                download={downloadName}
                aria-label="Download markdown"
                title="Download"
              >
                <Icon name="download" />
              </a>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          className="artifact-markdown-editor"
          aria-label="Markdown source"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
        />
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{coerceMarkdownInput(content)}</ReactMarkdown>
      )}
      {error ? <p className="artifact-markdown-error" role="alert">{error}</p> : null}
    </section>
  );
}

/** Best-effort filename for a markdown download: the backing file's basename
 *  when present, else a slugified title with a `.md` extension. */
function markdownDownloadName(filePath: string | undefined, title: string): string {
  return artifactBasename(filePath) ?? `${slugify(title, "document")}.md`;
}

const artifactPreviewCache = new Map<string, Promise<TimelineArtifact>>();

function LazyToolArtifactPreview({ artifact, title }: { readonly artifact: TimelineArtifact; readonly title: string }) {
  const [loaded, setLoaded] = useState<TimelineArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!artifact.artifactUrl || shouldLoad) return;
    // In real browsers, defer heavyweight truncated artifacts until the card is
    // near the viewport. A long presentation-heavy transcript can otherwise
    // fire tens of multi-MB /artifact requests on open, freezing both the API
    // worker and Chromium. jsdom lacks IntersectionObserver, so tests keep the
    // historical eager behavior.
    if (typeof IntersectionObserver !== "function") {
      setShouldLoad(true);
      return;
    }
    const el = hostRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShouldLoad(true);
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [artifact.artifactUrl, shouldLoad]);

  useEffect(() => {
    if (!artifact.artifactUrl || !shouldLoad) return;
    let cancelled = false;
    const url = `${import.meta.env.VITE_PI_CRUST_API_BASE ?? ""}${artifact.artifactUrl}`;
    let pending = artifactPreviewCache.get(url);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Artifact fetch failed (${response.status})`);
        return await response.json() as TimelineArtifact;
      })();
      artifactPreviewCache.set(url, pending);
    }
    setError(null);
    pending.then(
      (value) => { if (!cancelled) setLoaded(value); },
      (caught) => {
        artifactPreviewCache.delete(url);
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
    return () => { cancelled = true; };
  }, [artifact.artifactUrl, shouldLoad]);

  if (loaded) return <ArtifactPreview artifact={loaded} />;
  if (error) {
    return (
      <section ref={hostRef} className="artifact-preview artifact-data" role="alert" aria-label={`${title} failed to load`}>
        <strong>{title}</strong>
        <p>Could not load full artifact: {error}</p>
        <ArtifactFallback artifact={artifact} />
      </section>
    );
  }
  const size = typeof artifact.artifactFullBytes === "number" ? ` (${(artifact.artifactFullBytes / 1024 / 1024).toFixed(1)} MB)` : "";
  return (
    <section ref={hostRef} className="artifact-preview artifact-data" aria-label={`${title} loading`}>
      <strong>{title}</strong>
      <p>{shouldLoad ? <>Loading artifact{size}…</> : <>Artifact preview deferred{size}.</>}</p>
      {!shouldLoad ? <button type="button" onClick={() => setShouldLoad(true)}>Load artifact</button> : null}
    </section>
  );
}

function ArtifactFallback({ artifact }: { readonly artifact: TimelineArtifact }) {
  const title = artifact.title ?? `${artifact.kind} artifact`;
  return (
    <section className="artifact-preview artifact-data" aria-label={artifact.title ?? "Artifact data"}>
      <ArtifactPreviewHeader artifact={artifact} title={title} />
      <pre>{JSON.stringify(artifact.data ?? artifact, null, 2)}</pre>
    </section>
  );
}

/**
 * Renders a `customType: "artifact"` message from the @cemoody/pi-artifact extension.
 * Walks the multi-MIME representations array in order and renders the first
 * recognized format inline; always falls back to text/plain for unknown MIMEs.
 */
export function ArtifactView({
  artifact,
  fallbackText,
  enabledArtifactMimes,
}: {
  readonly artifact: TimelineArtifactDetails;
  readonly fallbackText: string;
  readonly enabledArtifactMimes: readonly string[] | undefined;
}) {
  const caption = artifact.caption;
  const rendered = pickRenderableRepresentation(artifact.artifacts, enabledArtifactMimes);

  return (
    <figure className="artifact-view" aria-label={caption ?? "Artifact"}>
      {caption ? <figcaption className="artifact-caption">{caption}</figcaption> : null}
      {rendered ?? <ArtifactPlainFallback artifacts={artifact.artifacts} message={fallbackText} />}
    </figure>
  );
}

function pickRenderableRepresentation(
  reps: readonly TimelineArtifactRepresentation[],
  enabledArtifactMimes?: readonly string[],
): ReactNode | null {
  const isEnabled = (mime: string) => enabledArtifactMimes === undefined || enabledArtifactMimes.includes(mime);
  for (const rep of reps) {
    const mime = rep.mime;
    if (mime === VEGA_LITE_MIME && rep.spec !== undefined) {
      return (
        <figure
          className="artifact-vega-lite"
          data-testid="artifact-vega-lite"
          data-spec={JSON.stringify(rep.spec)}
        >
          <Suspense fallback={<div className="artifact-loading">Loading chart…</div>}>
            <LazyVegaLiteChart spec={rep.spec} />
          </Suspense>
        </figure>
      );
    }
    if (typeof mime === "string" && mime.startsWith("image/")) {
      const src = rep.src && rep.src.kind === "url" ? rep.src.url : undefined;
      if (src) {
        return (
          <img
            className="artifact-image"
            data-testid="artifact-image"
            src={src}
            alt={rep.alt ?? ""}
            loading="lazy"
          />
        );
      }
    }
    if (mime === "text/markdown" && typeof rep.text === "string") {
      return (
        <section
          className="artifact-preview artifact-markdown"
          data-testid="artifact-markdown"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{coerceMarkdownInput(rep.text)}</ReactMarkdown>
        </section>
      );
    }
    if (mime === PRESENTATION_MIME && isEnabled(PRESENTATION_MIME) && (rep.spec !== undefined || rep.data !== undefined)) {
      return <PresentationArtifactCard deckInput={rep.spec ?? rep.data} title="Presentation" />;
    }
    if (mime === "text/html" && typeof rep.html === "string") {
      return (
        <iframe
          className="artifact-html"
          data-testid="artifact-html"
          // SECURITY: never include allow-same-origin. The artifact ships in the
          // host page's bundle, so an iframe with same-origin access could read
          // app cookies and DOM.
          sandbox="allow-scripts"
          srcDoc={rep.html}
          style={{ width: "100%", height: rep.height ?? 320, border: 0 }}
          title="Artifact"
        />
      );
    }
  }
  return null;
}

function ArtifactPlainFallback({
  artifacts,
  message,
}: {
  readonly artifacts: readonly TimelineArtifactRepresentation[];
  readonly message: string;
}) {
  const text = artifacts.find((rep) => rep.mime === "text/plain")?.text ?? message;
  return (
    <div className="artifact-fallback" data-testid="artifact-fallback">{text}</div>
  );
}
