import { Suspense, createContext, lazy, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { coerceMarkdownInput } from "../utils/safe-markdown.js";
import remarkGfm from "remark-gfm";
import { PRESENTATION_MIME, coercePresentationDeck, presentationFallbackMarkdown, type PresentationDeck } from "../../presentations/schema.js";
import { compileRevealHtml } from "../../presentations/reveal.js";
import { compileStandalonePresentationHtml } from "../../presentations/standalone.js";
import { applyDeckPatch, type DeckPatchOp } from "../../presentations/patch.js";
import { copyTextToClipboard } from "../utils/clipboard.js";
import "./message-timeline.css";

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

export interface TimelineImage {
  readonly id: string;
  readonly src: string;
  readonly alt?: string;
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
}

export interface TimelineToolDetails {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: "running" | "success" | "error";
  readonly output: string;
  readonly artifact?: TimelineArtifact;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

export interface TimelineMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "custom" | "summary" | "tool";
  readonly text: string;
  readonly thinking?: string;
  readonly images?: readonly TimelineImage[];
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly tokenUsage?: string;
  readonly cost?: string;
  readonly error?: string;
  readonly aborted?: boolean;
  readonly customLabel?: string;
  readonly customType?: string;
  readonly artifact?: TimelineArtifactDetails;
  readonly summaryKind?: "branch" | "compaction";
  readonly tool?: TimelineToolDetails;
  readonly timestamp?: number;
}

export interface MessageTimelineProps {
  readonly messages: readonly TimelineMessage[];
  readonly hideThinking?: boolean;
  readonly autoScroll?: boolean;
  readonly streaming?: boolean;
  readonly enabledArtifactMimes?: readonly string[];
  /** Active session id; threaded to presentation artifact cards so the
   *  Download HTML flow can fetch referenced assets from
   *  `/api/sessions/:sessionId/presentations/:file` and inline them as
   *  data: URIs, producing a fully self-contained, CDN-shippable file. */
  readonly sessionId?: string;
}

/** Context for child artifact cards that need the active session id (e.g.
 *  the presentation card's Download HTML asset-inlining flow). */
const TimelineSessionContext = createContext<string | undefined>(undefined);

// Pixels: if the user is within this many pixels of the bottom, treat as
// "pinned" — new content should auto-scroll. Generous because content can
// grow between scroll events while streaming.
const SCROLL_PIN_THRESHOLD_PX = 80;

export function MessageTimeline({ messages, hideThinking = false, autoScroll = true, streaming = false, enabledArtifactMimes, sessionId }: MessageTimelineProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);

  useEffect(() => { pinnedRef.current = pinned; }, [pinned]);

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) {
      endRef.current?.scrollIntoView?.({ block: "end" });
      return;
    }
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    // Also call scrollIntoView as a belt-and-braces fallback for environments
    // where the container itself isn't the actual scroll port.
    endRef.current?.scrollIntoView?.({ block: "end" });
  }

  // Initial mount: jump to bottom.
  useEffect(() => {
    if (!autoScroll) return;
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll when content grows, but only if the user is currently pinned.
  useEffect(() => {
    if (!autoScroll) return;
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom();
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [autoScroll]);

  // Watch the user's scroll position. If they come back near the bottom we
  // re-pin; if they leave, we unpin and surface the jump-to-latest button.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nextPinned = distance <= SCROLL_PIN_THRESHOLD_PX;
      if (nextPinned !== pinnedRef.current) setPinned(nextPinned);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const turns = groupTurns(messages);

  return (
    <TimelineSessionContext.Provider value={sessionId}>
    <section
      className="message-timeline"
      aria-label="Message timeline"
      ref={containerRef as React.RefObject<HTMLElement>}
      // Exposed so sibling CSS (.prompt-composer::before) can fade out
      // the gradient overlay when there's no scrolling content sliding
      // under it to mask — see prompt-composer.css.
      data-pinned={pinned ? "true" : "false"}
    >
      <div className="message-timeline-inner" ref={innerRef}>
        {turns.map((turn, turnIndex) => {
          const isLatest = turnIndex === turns.length - 1;
          const showFooter = !isLatest || !streaming;
          return (
            <div key={`turn-${turn.messages[0]?.id ?? turnIndex}`} className="timeline-turn">
              {turn.messages.map((message) => renderMessage(message, hideThinking, enabledArtifactMimes))}
              {showFooter && turn.messages.length > 0 ? <TurnFooter turn={turn} /> : null}
            </div>
          );
        })}
        {streaming ? <TypingDots /> : null}
        <div ref={endRef} data-testid="timeline-end" />
      </div>
      {autoScroll && !pinned ? (
        <button
          type="button"
          className="jump-to-latest"
          aria-label="Jump to latest"
          onClick={() => { scrollToBottom(); setPinned(true); }}
        >
          ↓ Jump to latest
        </button>
      ) : null}
    </section>
    </TimelineSessionContext.Provider>
  );
}

function renderMessage(message: TimelineMessage, hideThinking: boolean, enabledArtifactMimes: readonly string[] | undefined) {
  if (message.role === "tool") {
    return message.tool
      ? <ToolCard key={message.id} tool={message.tool} />
      : <OrphanToolResult key={message.id} text={message.text} />;
  }
  const showLabel = message.role === "custom" || message.role === "summary";
  const isArtifact = message.role === "custom" && message.customType === "artifact" && message.artifact;
  return (
    <article key={message.id} className={`message-card ${message.role}${isArtifact ? " artifact" : ""}`} aria-label={`${message.role} message`}>
      <header className={`message-header ${showLabel ? "" : "is-hidden"}`}>
        <strong>{messageTitle(message)}</strong>
        {message.aborted ? <span className="badge warning">aborted</span> : null}
        {message.error ? <span className="badge error">error</span> : null}
      </header>

      {message.images?.length ? (
        <div className="message-images">
          {message.images.map((image) => <img key={image.id} src={image.src} alt={image.alt ?? "attachment"} />)}
        </div>
      ) : null}

      {message.thinking && !hideThinking ? (
        <ThinkingCard thinking={message.thinking} />
      ) : null}

      {isArtifact ? (
        <ArtifactView artifact={message.artifact!} fallbackText={message.text} enabledArtifactMimes={enabledArtifactMimes} />
      ) : (
        <div className="message-bubble">
          <MarkdownLite text={message.text} />
        </div>
      )}

      {message.error ? <p role="alert" className="message-error">{message.error}</p> : null}

      <footer className="message-footer is-hidden">
        {message.provider ? <span>{message.provider}</span> : null}
        {message.model ? <span>{message.model}</span> : null}
        {message.stopReason ? <span>{message.stopReason}</span> : null}
        {message.tokenUsage ? <span>{message.tokenUsage}</span> : null}
        {message.cost ? <span>{message.cost}</span> : null}
        <CopyButton text={message.text} label="Copy" />
      </footer>
    </article>
  );
}

interface TurnGroup {
  readonly messages: readonly TimelineMessage[];
  readonly lastTimestamp: number | undefined;
}

function groupTurns(messages: readonly TimelineMessage[]): TurnGroup[] {
  const turns: TurnGroup[] = [];
  let buffer: TimelineMessage[] = [];
  function flush() {
    if (buffer.length === 0) return;
    const last = buffer.at(-1);
    turns.push({
      messages: buffer,
      lastTimestamp: last?.timestamp,
    });
    buffer = [];
  }
  for (const message of messages) {
    if (message.role === "user" && buffer.length > 0) flush();
    buffer.push(message);
  }
  flush();
  return turns;
}

function TurnFooter({ turn }: { readonly turn: TurnGroup }) {
  const [copied, setCopied] = useState<"" | "reply" | "turn" | "failed">("");
  const [now, setNow] = useState(() => Date.now());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(""), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const replyText = lastAssistantTextOf(turn);
  const canCopyReply = replyText.length > 0;

  async function copyReply() {
    if (!canCopyReply) return;
    setCopied(await copyText(replyText) ? "reply" : "failed");
  }

  async function copyEntireTurn() {
    setCopied(await copyText(turnToMarkdown(turn)) ? "turn" : "failed");
    setMenuOpen(false);
  }

  return (
    <div className="turn-footer" aria-label="Turn actions">
      <button
        type="button"
        className="turn-copy"
        aria-label="Copy assistant response"
        onClick={() => void copyReply()}
        disabled={!canCopyReply}
      >
        <CopyGlyph />
      </button>
      <div className="turn-menu" ref={menuRef}>
        <button
          type="button"
          className="turn-more"
          aria-label="More copy options"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreGlyph />
        </button>
        {menuOpen ? (
          <div className="turn-menu-popover" role="menu">
            <button type="button" role="menuitem" onClick={() => void copyEntireTurn()}>
              Copy entire turn as markdown
            </button>
          </div>
        ) : null}
      </div>
      {copied ? (
        <span className={copied === "failed" ? "turn-copy-failed" : "turn-copied"} role="status">
          {copied === "failed" ? "copy failed" : copied === "turn" ? "copied turn" : "copied"}
        </span>
      ) : null}
      {turn.lastTimestamp ? <span className="turn-age" title={new Date(turn.lastTimestamp).toLocaleString()}>{relativeTime(turn.lastTimestamp, now)}</span> : null}
    </div>
  );
}

/**
 * `message.text` is typed `string` but at runtime can be anything that
 * flows in from a malformed adapter / payload. Coerce defensively so a
 * single bad message can't take this whole codepath down (originally
 * observed as a TypeError in `text.trim` for a session whose text was
 * an Array; the SessionContentErrorBoundary caught it but the timeline
 * still failed to render fully). Pairs with safe-markdown.ts coercion.
 */
function asTrimmedString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try { return (typeof value === "object" ? JSON.stringify(value) : String(value)).trim(); }
  catch { return "[unserializable]"; }
}

function lastAssistantTextOf(turn: TurnGroup): string {
  for (let i = turn.messages.length - 1; i >= 0; i--) {
    const message = turn.messages[i];
    if (message && message.role === "assistant") {
      const trimmed = asTrimmedString(message.text);
      if (trimmed) return trimmed;
    }
  }
  return "";
}

function CopyGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M11.5 5.5V4A1.5 1.5 0 0 0 10 2.5H4A1.5 1.5 0 0 0 2.5 4v6A1.5 1.5 0 0 0 4 11.5h1.5" />
    </svg>
  );
}

function MoreGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

function turnToMarkdown(turn: TurnGroup): string {
  const parts: string[] = [];
  for (const message of turn.messages) {
    const text = asTrimmedString(message.text);
    if (message.role === "user") {
      parts.push(`**You:**\n\n${text}`);
    } else if (message.role === "assistant") {
      parts.push(`**Assistant:**\n\n${text}`);
    } else if (message.role === "tool" && message.tool) {
      const tool = message.tool;
      const args = Object.keys(tool.args).length > 0 ? `\n\n\`\`\`json\n${JSON.stringify(tool.args, null, 2)}\n\`\`\`` : "";
      const output = tool.output ? `\n\n\`\`\`\n${tool.output}\n\`\`\`` : "";
      parts.push(`**Tool · ${tool.name}** _(${tool.status})_${args}${output}`);
    } else if (message.role === "summary") {
      const kind = message.summaryKind === "branch" ? "Branch summary" : "Compaction summary";
      parts.push(`**${kind}:**\n\n${text}`);
    } else {
      parts.push(`_${message.customLabel ?? message.role}:_ ${text}`);
    }
  }
  return parts.join("\n\n");
}

function relativeTime(timestamp: number, now: number): string {
  const ms = Math.max(0, now - timestamp);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function TypingDots() {
  return (
    <div className="typing-dots" role="status" aria-label="Assistant is responding">
      <span /><span /><span />
    </div>
  );
}

function OrphanToolResult({ text }: { readonly text: string }) {
  return (
    <details className="orphan-tool-result tool-card success" aria-label="tool result">
      <summary>
        <span className="tool-icon" aria-hidden="true">✓</span>
        <span className="tool-line"><strong>Tool result</strong></span>
        <span className="tool-status-text">done</span>
      </summary>
      {text ? <pre>{text}</pre> : null}
    </details>
  );
}

function ToolCard({ tool }: { readonly tool: TimelineToolDetails }) {
  // Artifacts (slides, images, html, etc.) are the user-visible *output* of
  // tool calls like show_presentation / show_artifact. Render them outside
  // the collapsed <details> so they’re visible at a glance; the input
  // args and raw text output stay inside the details for debugging.
  return (
    <div className="tool-card-wrapper">
      <details className={`tool-card ${tool.status}`} aria-label={`tool ${tool.name}`}>
        <summary>
          <span className="tool-icon" aria-hidden="true">{toolIcon(tool.status)}</span>
          <span className="tool-line">
            <strong>{verbForName(tool.name)}</strong>
            {hasDedicatedVerb(tool.name) ? null : <> <code>{tool.name}</code></>}
            {summarizeArgs(tool.args) ? <> · <span className="tool-args">{summarizeArgs(tool.args)}</span></> : null}
          </span>
          <span className="tool-status-text">{statusLabel(tool)}</span>
        </summary>
        <ToolInputBlock tool={tool} />
        {tool.output ? <pre className="tool-output">{tool.output}</pre> : null}
      </details>
      {tool.artifact ? <ArtifactPreview artifact={tool.artifact} /> : null}
    </div>
  );
}

function ThinkingCard({ thinking }: { readonly thinking: string }) {
  // Visually parallels ToolCard so 'thinking' steps and tool calls share
  // a single anatomy: chevron + icon + verb + status-text + body. Still
  // tagged with .thinking-block so existing CSS / tests targeting that
  // class continue to apply.
  const preview = thinkingPreview(thinking);
  return (
    <details className="thinking-block tool-card thinking" aria-label="thinking step">
      <summary>
        <span className="tool-icon" aria-hidden="true">💡</span>
        <span className="tool-line">
          <strong>Thought</strong>
          {preview ? <> · <span className="tool-args thinking-preview">{preview}</span></> : null}
        </span>
      </summary>
      <pre className="thinking-body">{thinking}</pre>
    </details>
  );
}

function thinkingPreview(thinking: string): string {
  // First non-empty line, collapsed whitespace. Markdown bold-headers that
  // models often emit (e.g. **Considering options**) get unwrapped so the
  // preview reads as prose rather than punctuation. The .tool-args style
  // already truncates overflow with an ellipsis, so we don't slice here.
  for (const rawLine of thinking.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    return line.replace(/^\*\*(.+?)\*\*$/, "$1").replace(/\s+/g, " ");
  }
  return "";
}

function ToolInputBlock({ tool }: { readonly tool: TimelineToolDetails }) {
  const command = formatToolInput(tool);
  if (!command) return null;
  return (
    <section className="tool-input" aria-label="Tool input">
      <span className="tool-input-label">Input</span>
      <pre className="tool-input-body">{command}</pre>
    </section>
  );
}

function formatToolInput(tool: TimelineToolDetails): string {
  // For bash and similar shell-style tools the meaningful input is the
  // command. For everything else we fall back to a pretty-printed args
  // object (sans falsy values) so users see exactly what the agent
  // invoked the tool with.
  if (tool.name === "bash" && typeof tool.args.command === "string") {
    return tool.args.command;
  }
  if (tool.name === "read" && typeof tool.args.path === "string") {
    return tool.args.path;
  }
  if (tool.name === "write" && typeof tool.args.path === "string") {
    const content = typeof tool.args.content === "string" ? tool.args.content : "";
    return content ? `${tool.args.path}\n\n${content}` : tool.args.path;
  }
  if (tool.name === "edit" && typeof tool.args.path === "string") {
    return tool.args.path;
  }
  const keys = Object.keys(tool.args ?? {}).filter((k) => tool.args[k] !== undefined && tool.args[k] !== null && tool.args[k] !== "");
  if (keys.length === 0) return "";
  try {
    return JSON.stringify(tool.args, null, 2);
  } catch {
    return String(tool.args);
  }
}

function ArtifactPreview({ artifact }: { readonly artifact: TimelineArtifact }) {
  const title = artifact.title ?? `${artifact.kind} artifact`;
  if (artifact.kind === "image") {
    const src = artifact.url ?? artifact.path;
    return src ? (
      <figure className="artifact-preview artifact-image">
        <figcaption>{title}</figcaption>
        <img src={src} alt={artifact.alt ?? title} />
      </figure>
    ) : <ArtifactFallback artifact={artifact} />;
  }
  if (artifact.kind === "html" && artifact.html) {
    return (
      <figure className="artifact-preview artifact-html">
        <figcaption>{title}</figcaption>
        <iframe title={title} sandbox="" srcDoc={artifact.html} />
      </figure>
    );
  }
  if (artifact.kind === "markdown" && artifact.markdown) {
    return (
      <section className="artifact-preview artifact-markdown" aria-label={title}>
        <strong>{title}</strong>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{coerceMarkdownInput(artifact.markdown)}</ReactMarkdown>
      </section>
    );
  }
  if (artifact.kind === "presentation" && artifact.data) {
    return <PresentationArtifactCard deckInput={artifact.data} title={title} />;
  }
  return <ArtifactFallback artifact={artifact} />;
}

function ArtifactFallback({ artifact }: { readonly artifact: TimelineArtifact }) {
  return (
    <section className="artifact-preview artifact-data" aria-label={artifact.title ?? "Artifact data"}>
      <strong>{artifact.title ?? `${artifact.kind} artifact`}</strong>
      <pre>{JSON.stringify(artifact.data ?? artifact, null, 2)}</pre>
    </section>
  );
}

/**
 * Renders a `customType: "artifact"` message from the @cemoody/pi-artifact extension.
 * Walks the multi-MIME representations array in order and renders the first
 * recognized format inline; always falls back to text/plain for unknown MIMEs.
 */
function ArtifactView({
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
): React.ReactNode | null {
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

function PresentationArtifactCard({ deckInput, title }: { readonly deckInput: unknown; readonly title: string }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
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
  const closeModal = () => { void flushNow.current(); setOpen(false); setEditing(false); };

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
      return {
        // In-page Present modal stays synchronous — we don't need asset
        // inlining for an iframe that runs inside the same origin.
        html: compileRevealHtml(modalDeck, editing ? { editable: true } : {}),
        previewHtml: compileRevealHtml(stableDeck, { startSlide: 0, title: `${stableDeck.title} preview` }),
        markdown: presentationFallbackMarkdown(stableDeck),
      };
    } catch (error) {
      return { html: "", previewHtml: "", markdown: presentationFallbackMarkdown(stableDeck), error: error instanceof Error ? error.message : String(error) };
    }
  }, [stableDeck, modalDeck, editing]);
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
      <section className="artifact-preview artifact-data" role="alert">
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
          <button type="button" onClick={() => setOpen(true)}>Present deck</button>
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
        <div className="presentation-modal" role="dialog" aria-modal="true" aria-label={`${deck.title} presentation`}>
          <div className="presentation-modal-toolbar">
            <strong>{deck.title}</strong>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              aria-pressed={editing}
              disabled={!sessionId || !deckId}
              title={!sessionId || !deckId ? "Editing requires a session and a deck id" : undefined}
            >
              {editing ? "Editing…" : "Edit"}
            </button>
            <button type="button" onClick={closeModal} aria-label="Close presentation">×</button>
          </div>
          {editing && deck.slides.some((slide) => typeof slide.html === "string" && slide.html.length > 0) ? (
            <div className="presentation-edit-banner" role="status">
              Edit not supported for templated slides.
            </div>
          ) : null}
          {editError ? (
            <div className="presentation-edit-error" role="alert">{editError}</div>
          ) : null}
          <iframe
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

function toolIcon(status: TimelineToolDetails["status"]): string {
  if (status === "running") return "•";
  if (status === "error") return "✕";
  return "✓";
}

function statusLabel(tool: TimelineToolDetails): string {
  if (tool.status === "running") return "running…";
  if (tool.status === "error") return "failed";
  const duration = formatToolDuration(tool);
  return duration ?? "done";
}

function formatToolDuration(tool: TimelineToolDetails): string | null {
  if (tool.startedAt === undefined || tool.completedAt === undefined) return null;
  const ms = Math.max(0, tool.completedAt - tool.startedAt);
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes - hours * 60;
  return remMinutes === 0 ? `${hours} hr` : `${hours} hr ${remMinutes} min`;
}

const TOOL_VERBS: Record<string, string> = {
  bash: "Ran",
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  grep: "Searched",
  find: "Found",
  ls: "Listed",
};

function verbForName(name: string): string {
  return TOOL_VERBS[name] ?? "Ran";
}

function hasDedicatedVerb(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_VERBS, name);
}

function summarizeArgs(args: Record<string, unknown>): string {
  const preferred = ["command", "path", "file", "pattern", "query"];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return truncate(value, 80);
  }
  return "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function messageTitle(message: TimelineMessage): string {
  if (message.role === "custom") return message.customLabel ?? "Extension";
  if (message.role === "summary") return message.summaryKind === "branch" ? "Branch summary" : "Compaction summary";
  return message.role === "assistant" ? "Assistant" : "You";
}

function MarkdownLite({ text }: { readonly text: unknown }) {
  // `text` is typed as string at the call site but in practice can be
  // anything that flows in via message.text / artifact payloads. Coerce
  // up front so react-markdown's assertion doesn't blow up the tree.
  const safeText = coerceMarkdownInput(text);
  return (
    <div className="markdown-lite">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre(props) {
            const child = Array.isArray(props.children) ? props.children[0] : props.children;
            const inner = (child && typeof child === "object" && "props" in child)
              ? (child as { props: { className?: string; children?: React.ReactNode } }).props
              : { className: undefined, children: childrenToString(props.children) };
            const value = childrenToString(inner.children);
            return (
              <div className="code-block">
                <CopyButton text={value} label="Copy code" copiedLabel="Copied" failedLabel="Copy failed" />
                <pre><code className={inner.className}>{value}</code></pre>
              </div>
            );
          },
          code(props) {
            const { className, children } = props as { className?: string; children?: React.ReactNode };
            return <code className={className}>{children}</code>;
          },
          a(props) {
            const { href, children } = props as { href?: string; children?: React.ReactNode };
            return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
        }}
      >
        {safeText}
      </ReactMarkdown>
    </div>
  );
}

function childrenToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(childrenToString).join("");
  return String(value);
}

function CopyButton({ text, label, copiedLabel = "Copied", failedLabel = "Copy failed" }: {
  readonly text: string;
  readonly label: string;
  readonly copiedLabel?: string;
  readonly failedLabel?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 1500);
    return () => clearTimeout(timer);
  }, [status]);

  async function onCopy() {
    setStatus(await copyText(text) ? "copied" : "failed");
  }

  return (
    <button type="button" className={status === "failed" ? "copy-failed" : undefined} onClick={() => void onCopy()}>
      {status === "failed" ? failedLabel : status === "copied" ? copiedLabel : label}
    </button>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await copyTextToClipboard(text);
    return true;
  } catch (error) {
    console.warn("Unable to copy text to clipboard", error);
    return false;
  }
}
