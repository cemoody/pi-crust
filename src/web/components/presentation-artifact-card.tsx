/**
 * PresentationArtifactCard — renders a `show_presentation` artifact as a
 * preview iframe with a "Full screen" modal, an editable mode, optimistic
 * PATCH edits debounced through `/api/sessions/:id/presentations/:deckId/deck.json`,
 * and a Download HTML button backed by `compileStandalonePresentationHtml`.
 *
 * Extracted from MessageTimeline.tsx (which retained the rest of the
 * timeline scaffolding). Behavior is unchanged; pinned by
 * tests/unit/presentation-artifact-rendering.test.tsx and
 * tests/unit/presentation-editable-card.test.tsx.
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { coerceMarkdownInput } from "../utils/safe-markdown.js";
import { coercePresentationDeck, presentationFallbackMarkdown, type PresentationDeck } from "../../presentations/schema.js";
import { compileRevealHtml } from "../../presentations/reveal.js";
import { withAbsolutePresentationAssetUrls } from "../../presentations/absolute-asset-urls.js";
import { compileStandalonePresentationHtml } from "../../presentations/standalone.js";
import { applyDeckPatch, type DeckPatchOp } from "../../presentations/patch.js";
import { TimelineSessionContext } from "./timeline-session-context.js";

export function PresentationArtifactCard({ deckInput, title }: { readonly deckInput: unknown; readonly title: string }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const modalIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [slideState, setSlideState] = useState<{ index: number; total: number }>({ index: 0, total: 0 });
  const [editError, setEditError] = useState<string | null>(null);
  const sessionId = useContext(TimelineSessionContext);
  const parsed = useMemo((): { deck?: PresentationDeck; error?: string } => {
    try {
      return { deck: coercePresentationDeck(deckInput) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [deckInput]);
  const baseDeck = parsed.deck;
  const deckId = baseDeck?.id;

  // Hydration: GET <deckId>.deck.json on mount. If present, it supersedes
  // the in-message deck so refresh-after-edit shows the persisted version.
  const [persisted, setPersisted] = useState<PresentationDeck | null>(null);
  useEffect(() => {
    if (!sessionId || !deckId) return;
    let cancelled = false;
    (async () => {
      try {
        const apiBase = (import.meta as ImportMeta).env?.VITE_PI_CRUST_API_BASE ?? "";
        const url = `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/presentations/${encodeURIComponent(deckId)}/deck.json`;
        const res = await fetch(url);
        if (!res.ok) return;
        const envelope = await res.json();
        if (!cancelled && envelope?.deck && typeof envelope.deck === "object") {
          setPersisted(envelope.deck as PresentationDeck);
        }
      } catch {
        // ignore — fall back to deckInput
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, deckId]);

  // Optimistic edits applied locally pending PATCH confirmation.
  const [optimistic, setOptimistic] = useState<PresentationDeck | null>(null);
  const deck = optimistic ?? persisted ?? baseDeck;

  // Debounced PATCH machinery. We batch ops within a single 500 ms window
  // and coalesce by path (last write wins per pointer).
  const pendingOpsRef = useRef<DeckPatchOp[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedDeckRef = useRef<PresentationDeck | null>(null);
  useEffect(() => {
    confirmedDeckRef.current = persisted ?? baseDeck ?? null;
  }, [persisted, baseDeck]);

  const flushNow = useRef<() => Promise<void>>(async () => undefined);
  flushNow.current = async () => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    const ops = pendingOpsRef.current;
    if (!ops.length || !sessionId || !deckId) return;
    pendingOpsRef.current = [];
    const apiBase = (import.meta as ImportMeta).env?.VITE_PI_CRUST_API_BASE ?? "";
    const url = `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/presentations/${encodeURIComponent(deckId)}/deck.json`;
    const initial = confirmedDeckRef.current ?? baseDeck;
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ops, initial }),
      });
      if (!res.ok) {
        let detail = "Could not save edits";
        try { const body = await res.json(); detail = body?.error ?? detail; } catch { /* ignore */ }
        setEditError(detail);
        // Roll back to last server-confirmed deck.
        setOptimistic(null);
        return;
      }
      const envelope = await res.json();
      if (envelope?.deck) {
        setPersisted(envelope.deck as PresentationDeck);
        setOptimistic(null);
        setEditError(null);
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
      setOptimistic(null);
    }
  };

  // Listen for slide-state postMessage from the modal iframe so the outer
  // prev/next buttons can disable at the edges and show a 'n / N' counter.
  useEffect(() => {
    if (!open) return;
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== "pi-deck-state") return;
      if (typeof data.index !== "number" || typeof data.total !== "number") return;
      setSlideState({ index: data.index, total: data.total });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);

  const postNav = (dir: "prev" | "next" | "first" | "last") => {
    const win = modalIframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "pi-deck-nav", dir }, "*");
  };

  // Listen for postMessage edits from the modal iframe.
  useEffect(() => {
    if (!open || !editing) return;
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "pi-deck-edit") return;
      if (typeof data.path !== "string" || typeof data.value !== "string") return;
      if (deckId && data.deckId && data.deckId !== deckId) return;
      const op: DeckPatchOp = { op: "replace", path: data.path, value: data.value };
      // Coalesce by path: replace any earlier op for the same path.
      pendingOpsRef.current = pendingOpsRef.current.filter((o) => o.path !== op.path);
      pendingOpsRef.current.push(op);
      // Apply optimistically.
      const base = optimistic ?? persisted ?? baseDeck;
      if (base) {
        try { setOptimistic(applyDeckPatch(base, [op])); }
        catch (err) { setEditError(err instanceof Error ? err.message : String(err)); }
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => { void flushNow.current(); }, 500);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, editing, deckId, optimistic, persisted, baseDeck]);

  // Flush pending edits when closing the modal.
  const closeModal = () => {
    void flushNow.current();
    setOpen(false);
    setEditing(false);
    setPresenting(false);
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  };

  // Toggle minimal “presentation mode” — hides the toolbar and requests
  // real browser fullscreen on the modal so the slides own the viewport.
  const enterPresentationMode = () => {
    setPresenting(true);
    const el = modalRef.current;
    if (el && typeof el.requestFullscreen === "function" && !document.fullscreenElement) {
      void el.requestFullscreen().catch(() => undefined);
    }
  };
  const exitPresentationMode = () => {
    setPresenting(false);
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  };

  // Sync presentation-mode state if the user exits fullscreen via Esc / browser UI.
  useEffect(() => {
    if (!open) return;
    function onFsChange() {
      if (!document.fullscreenElement && presenting) setPresenting(false);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [open, presenting]);

  // The modal iframe's srcDoc is deliberately *frozen* while editing. If
  // we recompiled it whenever `persisted` updated (which happens after
  // every successful PATCH), the iframe would re-mount and detach the
  // focused contenteditable element mid-typing. We snapshot the deck at
  // the moment the user enters edit mode and reuse that until they exit.
  const [modalSnapshot, setModalSnapshot] = useState<PresentationDeck | null>(null);
  useEffect(() => {
    if (editing) {
      if (modalSnapshot === null) setModalSnapshot(persisted ?? baseDeck ?? null);
    } else {
      setModalSnapshot(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const stableDeck = persisted ?? baseDeck;
  const modalDeck = editing ? (modalSnapshot ?? stableDeck) : stableDeck;
  const compiled = useMemo((): { html: string; previewHtml: string; markdown: string; error?: string } => {
    if (!stableDeck || !modalDeck) return { html: "", previewHtml: "", markdown: "" };
    try {
      // Rewrite every bare `image.src` (and `<img src>` inside passthrough
      // HTML) to an absolute API URL pointing at the per-session asset
      // route. The preview/modal iframes use srcDoc, which means relative
      // URLs have no usable base — a bare `chart.png` resolves against
      // `about:srcdoc` and shows as a broken-image icon even when the
      // file was correctly auto-copied (#168). The standalone download
      // path doesn't need this because it inlines assets as data: URIs.
      const apiBase = (import.meta as ImportMeta).env?.VITE_PI_CRUST_API_BASE ?? "";
      const absStable = sessionId
        ? withAbsolutePresentationAssetUrls(stableDeck, { apiBase, sessionId })
        : stableDeck;
      const absModal = sessionId
        ? withAbsolutePresentationAssetUrls(modalDeck, { apiBase, sessionId })
        : modalDeck;
      return {
        // In-page Present modal stays synchronous — we don't need asset
        // inlining for an iframe that runs inside the same origin.
        html: compileRevealHtml(absModal, editing ? { editable: true } : {}),
        previewHtml: compileRevealHtml(absStable, { startSlide: 0, title: `${stableDeck.title} preview` }),
        markdown: presentationFallbackMarkdown(stableDeck),
      };
    } catch (error) {
      return { html: "", previewHtml: "", markdown: presentationFallbackMarkdown(stableDeck), error: error instanceof Error ? error.message : String(error) };
    }
  }, [stableDeck, modalDeck, editing, sessionId]);
  const { html, previewHtml, markdown } = compiled;
  const compileError = compiled.error;

  // The Download HTML flow compiles a fully self-contained file with every
  // referenced asset inlined as a data: URI, so the result can be uploaded
  // to any static CDN (R2 / S3 / etc.) and rendered offline.
  const [standalone, setStandalone] = useState<{ html: string; error?: string } | null>(null);
  useEffect(() => {
    if (!deck) { setStandalone(null); return; }
    let cancelled = false;
    setStandalone(null);
    (async () => {
      try {
        const html = await compileStandalonePresentationHtml(
          deck,
          sessionId ? { fetchAsset: makeSessionAssetFetcher(sessionId) } : {},
        );
        if (!cancelled) setStandalone({ html });
      } catch (error) {
        if (!cancelled) setStandalone({ html: "", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [deck, sessionId]);
  const downloadUrl = useMemo(
    () => standalone?.html ? URL.createObjectURL(new Blob([standalone.html], { type: "text/html" })) : "",
    [standalone?.html],
  );
  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);

  if (!deck) {
    return (
      <section className="artifact-preview artifact-data" data-testid="artifact-presentation" role="alert" aria-label={title}>
        <strong>Invalid presentation</strong>
        <pre>{parsed.error}</pre>
      </section>
    );
  }

  if (compileError) {
    return (
      <section className="artifact-preview artifact-data" data-testid="artifact-presentation" role="alert" aria-label={deck.title || title}>
        <strong>Could not render presentation preview</strong>
        <pre>{compileError}</pre>
        <details>
          <summary>Fallback outline</summary>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{coerceMarkdownInput(markdown)}</ReactMarkdown>
        </details>
      </section>
    );
  }

  return (
    <section className="presentation-artifact" data-testid="artifact-presentation" aria-label={deck.title || title}>
      <div className="presentation-card-header">
        <div>
          <strong>{deck.title || title}</strong>
          <span>{deck.slides.length} slide{deck.slides.length === 1 ? "" : "s"}</span>
        </div>
        <div className="presentation-actions">
          <button type="button" onClick={() => setOpen(true)}>Full screen</button>
          {downloadUrl ? (
            <a href={downloadUrl} download={`${slugify(deck.title || title)}.html`}>Download HTML</a>
          ) : (
            <span
              className="presentation-download-pending"
              aria-disabled="true"
              title={standalone?.error ?? "Compiling self-contained deck…"}
            >
              {standalone?.error ? "Download unavailable" : "Preparing…"}
            </span>
          )}
        </div>
      </div>
      <iframe
        className="presentation-preview"
        data-testid="artifact-presentation-preview"
        sandbox="allow-scripts"
        srcDoc={previewHtml}
        title={`${deck.title} preview`}
      />
      <details className="presentation-fallback-markdown">
        <summary>Fallback outline</summary>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{coerceMarkdownInput(markdown)}</ReactMarkdown>
      </details>
      {open ? (
        <div
          ref={modalRef}
          className={`presentation-modal${presenting ? " presentation-modal-presenting" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={`${deck.title} presentation`}
        >
          {presenting ? (
            <>
              <button
                type="button"
                className="presentation-modal-exit"
                onClick={exitPresentationMode}
                aria-label="Exit presentation mode"
                title="Exit presentation mode (Esc)"
              >
                ×
              </button>
              <div className="presentation-modal-nav" role="group" aria-label="Slide navigation">
                <button
                  type="button"
                  onClick={() => postNav("prev")}
                  disabled={slideState.total > 0 && slideState.index <= 0}
                  aria-label="Previous slide"
                  title="Previous slide (←)"
                >
                  ‹
                </button>
                {slideState.total > 0 ? (
                  <span className="presentation-modal-nav-counter">{slideState.index + 1} / {slideState.total}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => postNav("next")}
                  disabled={slideState.total > 0 && slideState.index >= slideState.total - 1}
                  aria-label="Next slide"
                  title="Next slide (→)"
                >
                  ›
                </button>
              </div>
            </>
          ) : (
            <div className="presentation-modal-toolbar">
              <strong>{deck.title}</strong>
              <div className="presentation-modal-toolbar-actions">
                <div className="presentation-modal-nav presentation-modal-nav-inline" role="group" aria-label="Slide navigation">
                  <button
                    type="button"
                    onClick={() => postNav("prev")}
                    disabled={slideState.total > 0 && slideState.index <= 0}
                    aria-label="Previous slide"
                    title="Previous slide (←)"
                  >
                    ‹
                  </button>
                  {slideState.total > 0 ? (
                    <span className="presentation-modal-nav-counter">{slideState.index + 1} / {slideState.total}</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => postNav("next")}
                    disabled={slideState.total > 0 && slideState.index >= slideState.total - 1}
                    aria-label="Next slide"
                    title="Next slide (→)"
                  >
                    ›
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing((v) => !v)}
                  aria-pressed={editing}
                  disabled={!sessionId || !deckId}
                  title={!sessionId || !deckId ? "Editing requires a session and a deck id" : undefined}
                >
                  {editing ? "Editing…" : "Edit"}
                </button>
                <button
                  type="button"
                  onClick={enterPresentationMode}
                  title="Hide controls and fill the screen"
                >
                  Presentation mode
                </button>
                <button
                  type="button"
                  className="presentation-modal-close"
                  onClick={closeModal}
                  aria-label="Close presentation"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {editing && deck.slides.some((slide) => typeof slide.html === "string" && slide.html.length > 0) ? (
            <div className="presentation-edit-banner" role="status">
              Edit not supported for templated slides.
            </div>
          ) : null}
          {editError ? (
            <div className="presentation-edit-error" role="alert">{editError}</div>
          ) : null}
          <iframe
            ref={modalIframeRef}
            data-testid="artifact-presentation-modal"
            sandbox="allow-scripts"
            srcDoc={html}
            title={deck.title}
          />
        </div>
      ) : null}
    </section>
  );
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "presentation";
}

/**
 * Returns a fetchAsset() implementation that pulls referenced presentation
 * assets from the per-session route exposed by the presentations extension:
 *   GET /api/sessions/:sessionId/presentations/:file
 * The route serves files from `<session.cwd>/.pi/presentations/<sessionId>/`,
 * which is where show_presentation / pi-crust writes deck assets.
 */
function makeSessionAssetFetcher(sessionId: string) {
  // Match the rest of the pi-crust's API client — honour VITE_PI_CRUST_API_BASE
  // so dev/test setups that run the API on a different port work correctly.
  const apiBase = (import.meta as ImportMeta).env?.VITE_PI_CRUST_API_BASE ?? "";
  return async (src: string) => {
    const url = `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/presentations/${encodeURIComponent(src)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`asset fetch ${res.status} for ${src}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    return { data: buf, mimeType };
  };
}

// end of file
