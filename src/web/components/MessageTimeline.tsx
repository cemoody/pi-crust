import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { coerceMarkdownInput } from "../utils/safe-markdown.js";
import remarkGfm from "remark-gfm";
import { PRESENTATION_MIME } from "../../presentations/schema.js";
import { copyTextToClipboard } from "../utils/clipboard.js";
import "./message-timeline.css";
import { Icon } from "./Icon.js";
import { TimelineSessionContext } from "./timeline-session-context.js";
import { PresentationArtifactCard } from "./presentation-artifact-card.js";
import { PrStoryArtifactCard } from "./pr-story-artifact-card.js";
import { useOptionalNotifications } from "./notifications.js";

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
  readonly artifactUrl?: string;
  readonly artifactTruncated?: boolean;
  readonly artifactFullBytes?: number;
}

export interface TimelineToolDetails {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: "running" | "success" | "error";
  readonly output: string;
  readonly artifact?: TimelineArtifact;
  /** Images emitted by the tool result (e.g. read of a PNG). Either inline
   *  base64 `data` (live SSE) or a server-hosted `url` (after reload). */
  readonly images?: readonly { readonly data?: string; readonly url?: string; readonly mimeType: string }[];
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
  /** Whether more (older) messages exist on the server. When true and the
   *  user scrolls near the top of the timeline, `onLoadOlder` is invoked.
   *  Used to paginate long transcripts that exceed the initial-fetch cap. */
  readonly hasMoreOlder?: boolean;
  /** Whether an older-page fetch is in flight. While true the timeline
   *  shows a small loading indicator at the top and won't trigger more
   *  fetches. */
  readonly loadingOlder?: boolean;
  /** Called when the user scrolls near the top and more history is
   *  available. The parent is responsible for fetching + prepending the
   *  older messages; the timeline preserves the visual scroll position
   *  across that prepend. */
  readonly onLoadOlder?: () => void;
}

/** Context for child artifact cards that need the active session id (e.g.
 *  the presentation card's Download HTML asset-inlining flow). */
// TimelineSessionContext lives in its own module so subcomponents can
// consume it without importing from this file (which would create a cycle).
// See ./timeline-session-context.tsx.

// Pixels: if the user is within this many pixels of the bottom, treat as
// "pinned" — new content should auto-scroll. Generous because content can
// grow between scroll events while streaming.
const SCROLL_PIN_THRESHOLD_PX = 80;
// Pixels: if the user scrolls within this many pixels of the top and there
// is more history available, fire onLoadOlder. Generous so a fast scroll-up
// gesture reliably triggers a fetch before the user runs out of content.
const SCROLL_LOAD_OLDER_THRESHOLD_PX = 200;

export function MessageTimeline({ messages, hideThinking = false, autoScroll = true, streaming = false, enabledArtifactMimes, sessionId, hasMoreOlder = false, loadingOlder = false, onLoadOlder }: MessageTimelineProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  // When we ask the parent to load older messages we snapshot
  // `scrollHeight - scrollTop` so that, after the new (taller) DOM lands,
  // we can restore the same visual offset from the bottom. Without this,
  // a prepend would yank the user back to the top of the new content and
  // make pagination feel like an unwanted jump.
  const restoreDistanceFromBottomRef = useRef<number | null>(null);
  // Latest values exposed to the scroll handler (which is registered once
  // for the lifetime of the component, so closure captures of these props
  // would go stale).
  const onLoadOlderRef = useRef(onLoadOlder);
  const hasMoreOlderRef = useRef(hasMoreOlder);
  const loadingOlderRef = useRef(loadingOlder);
  useEffect(() => { onLoadOlderRef.current = onLoadOlder; }, [onLoadOlder]);
  useEffect(() => { hasMoreOlderRef.current = hasMoreOlder; }, [hasMoreOlder]);
  useEffect(() => { loadingOlderRef.current = loadingOlder; }, [loadingOlder]);

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
  // We also use this same listener to lazily fetch *older* messages when
  // the user scrolls near the top of the timeline — the initial transcript
  // fetch is capped at INITIAL_MESSAGES_LIMIT entries, so without this hook
  // long sessions would only ever render their tail.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nextPinned = distance <= SCROLL_PIN_THRESHOLD_PX;
      if (nextPinned !== pinnedRef.current) setPinned(nextPinned);
      // Top-edge lazy load. Only fires when more is known to exist and a
      // fetch isn't already running.
      if (
        el.scrollTop <= SCROLL_LOAD_OLDER_THRESHOLD_PX &&
        hasMoreOlderRef.current &&
        !loadingOlderRef.current &&
        onLoadOlderRef.current
      ) {
        // Snapshot distance-from-bottom *before* the prepend so the
        // useLayoutEffect below can restore the same visual offset once
        // the new DOM has been measured.
        restoreDistanceFromBottomRef.current = el.scrollHeight - el.scrollTop;
        onLoadOlderRef.current();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // After an older-page fetch lands and the DOM has grown taller, restore
  // the user's previous visual position by aligning `scrollTop` so that
  // `scrollHeight - scrollTop` matches the snapshot we took just before
  // requesting more history. Synchronous (useLayoutEffect) so the user
  // never sees an intermediate frame where the scroll position jumped.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const saved = restoreDistanceFromBottomRef.current;
    if (!el || saved == null) return;
    if (loadingOlder) return; // wait until the fetch completes
    el.scrollTop = el.scrollHeight - saved;
    restoreDistanceFromBottomRef.current = null;
  }, [messages, loadingOlder]);

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
        {hasMoreOlder || loadingOlder ? (
          <div
            className="message-timeline-older-loader"
            data-testid="timeline-older-loader"
            role="status"
            aria-live="polite"
          >
            {loadingOlder ? "Loading earlier messages…" : "Scroll up to load earlier messages"}
          </div>
        ) : null}
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
  const notifications = useOptionalNotifications();
  // Same fallback pattern as ToolCard: prefer a transient toast when a
  // provider is mounted; otherwise keep the inline pill so the timeline
  // is usable standalone.
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

  function reportCopy(label: "reply" | "turn", ok: boolean) {
    if (notifications) {
      if (ok) notifications.notify({ kind: "success", message: label === "turn" ? "Copied turn" : "Copied reply", durationMs: 1_800 });
      else notifications.notify({ kind: "error", message: "Copy failed" });
      return;
    }
    setCopied(ok ? label : "failed");
  }

  async function copyReply() {
    if (!canCopyReply) return;
    reportCopy("reply", await copyText(replyText));
  }

  async function copyEntireTurn() {
    reportCopy("turn", await copyText(turnToMarkdown(turn)));
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
      {!notifications && copied ? (
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

function CopyGlyph() { return <Icon name="copy" />; }
function MoreGlyph() { return <Icon name="more" />; }

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
  const [open, setOpen] = useState(false);
  return (
    <details
      className="orphan-tool-result tool-card success"
      aria-label="tool result"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-icon" aria-hidden="true">✓</span>
        <span className="tool-line"><strong>Tool result</strong></span>
        <span className="tool-status-text">done</span>
      </summary>
      {open && text ? <pre>{text}</pre> : null}
    </details>
  );
}

function ToolCard({ tool }: { readonly tool: TimelineToolDetails }) {
  // Artifacts (slides, images, html, etc.) are the user-visible *output* of
  // tool calls like show_presentation / show_artifact. Render them outside
  // the collapsed <details> so they’re visible at a glance; the input
  // args and raw text output stay inside the details for debugging.
  //
  // Important performance detail: do NOT mount the details body while the
  // disclosure is closed. Long sessions commonly have hundreds of successful
  // tool calls; mounting every hidden <pre>, image, iframe, and artifact fetch
  // at page-load makes Chromium keep tens of thousands of nodes and huge text
  // strings alive even though the cards are collapsed. Lazy-mounting the body
  // is the normal pattern here: render the cheap summary rows up front, then
  // hydrate the expensive output only when the user opens a card.
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-card-wrapper">
      <details
        className={`tool-card ${tool.status}`}
        aria-label={`tool ${tool.name}`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="tool-icon" aria-hidden="true">{toolIcon(tool.status)}</span>
          <span className="tool-line">
            <strong>{verbForName(tool.name)}</strong>
            {hasDedicatedVerb(tool.name) ? null : <> <code>{tool.name}</code></>}
            {summarizeArgs(tool.args) ? <> · <span className="tool-args">{summarizeArgs(tool.args)}</span></> : null}
          </span>
          <span className="tool-status-text">{statusLabel(tool)}</span>
        </summary>
        {open ? (
          <>
            <ToolInputBlock tool={tool} />
            <ToolResultBody tool={tool} />
          </>
        ) : null}
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
  const [open, setOpen] = useState(false);
  const preview = thinkingPreview(thinking);
  return (
    <details
      className="thinking-block tool-card thinking"
      aria-label="thinking step"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-icon" aria-hidden="true">💡</span>
        <span className="tool-line">
          <strong>Thought</strong>
          {preview ? <> · <span className="tool-args thinking-preview">{preview}</span></> : null}
        </span>
      </summary>
      {open ? <pre className="thinking-body">{thinking}</pre> : null}
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

/**
 * Renders the *result* of a tool call inside its expandable card. Most tools
 * just show their text output in a <pre>, but a few read-shaped results are
 * worth rendering richly so users don't have to squint at a path or raw markup:
 *
 *   - image reads (the read tool reading a PNG/JPEG/…) render the actual image
 *     instead of only the "[Read image file …]" note.
 *   - markdown reads (*.md) render formatted markdown.
 *   - html reads (*.html) render in a sandboxed iframe.
 *
 * Everything else falls back to the plain <pre> output.
 */
function ToolResultBody({ tool }: { readonly tool: TimelineToolDetails }) {
  const images = tool.images ?? [];
  if (images.length > 0) {
    return (
      <div className="tool-result-images">
        {tool.output ? <pre className="tool-output tool-output-note">{tool.output}</pre> : null}
        {images.map((image, index) => {
          const src = toolImageSrc(image);
          if (!src) return null;
          return (
            <figure key={index} className="tool-image">
              <img src={src} alt={`${tool.name} image ${index + 1}`} />
            </figure>
          );
        })}
      </div>
    );
  }

  const richKind = readRichKind(tool);
  if (richKind === "markdown" && tool.output) {
    return (
      <div className="tool-read-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{coerceMarkdownInput(tool.output)}</ReactMarkdown>
      </div>
    );
  }
  if (richKind === "html" && tool.output) {
    return (
      <figure className="tool-read-html">
        <iframe title="HTML preview" className="artifact-html" sandbox="" srcDoc={tool.output} />
      </figure>
    );
  }

  return tool.output ? <pre className="tool-output">{tool.output}</pre> : null;
}

/** Resolve a tool image to a usable <img> src: inline base64 data URI (live
 *  SSE) or a server-hosted URL (after reload, possibly under an API base). */
function toolImageSrc(image: { readonly data?: string; readonly url?: string; readonly mimeType: string }): string | undefined {
  if (typeof image.data === "string" && image.data.length > 0) {
    return `data:${image.mimeType ?? "image/png"};base64,${image.data}`;
  }
  if (typeof image.url === "string" && image.url.length > 0) {
    const base = import.meta.env.VITE_PI_CRUST_API_BASE ?? "";
    return image.url.startsWith("/api/") ? `${base}${image.url}` : image.url;
  }
  return undefined;
}

/** Detect whether a read result should render as rich markdown/html based on
 *  the file extension of the read path. Only applies to the read tool. */
function readRichKind(tool: TimelineToolDetails): "markdown" | "html" | undefined {
  if (tool.name !== "read") return undefined;
  const path = typeof tool.args?.path === "string" ? tool.args.path : undefined;
  if (!path) return undefined;
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return undefined;
}

/** Resolve an artifact `path`/`url` into a fetchable href, prefixing the
 *  configured API base for same-origin `/api/...` routes. */
function resolveArtifactSrc(src: string | undefined): string | undefined {
  if (typeof src !== "string" || src.length === 0) return undefined;
  const base = import.meta.env.VITE_PI_CRUST_API_BASE ?? "";
  return src.startsWith("/api/") ? `${base}${src}` : src;
}

/** Basename of a path/url (query string stripped), or undefined when empty. */
function artifactBasename(candidate: string | undefined): string | undefined {
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  const withoutQuery = candidate.split(/[?#]/)[0] ?? candidate;
  const base = withoutQuery.split(/[\\/]/).pop();
  return base && base.length > 0 ? base : undefined;
}

function slugifyTitle(title: string, fallback = "artifact"): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
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
    const name = artifactBasename(artifact.path) ?? `${slugifyTitle(title)}.${blob.ext}`;
    return { href: objectUrl, name };
  }
  const src = resolveArtifactSrc(artifact.url ?? artifact.path);
  if (src) {
    return { href: src, name: artifactBasename(artifact.path ?? artifact.url) ?? slugifyTitle(title) };
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

function ArtifactPreview({ artifact }: { readonly artifact: TimelineArtifact }) {
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
  if (typeof filePath === "string" && filePath.length > 0) {
    const base = filePath.split(/[\\/]/).pop();
    if (base) return base;
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "document";
  return `${slug}.md`;
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
