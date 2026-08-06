import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { coerceMarkdownInput } from "../utils/safe-markdown.js";
import remarkGfm from "remark-gfm";
import { truncateWithEllipsis } from "../../shared/truncation.js";
import { copyTextToClipboard } from "../utils/clipboard.js";
import "./message-timeline.css";
import { Icon } from "./Icon.js";
import { TimelineSessionContext } from "./timeline-session-context.js";
import { useOptionalNotifications } from "./notifications.js";
import {
  ArtifactPreview,
  ArtifactView,
  type TimelineArtifact,
  type TimelineArtifactDetails,
  type TimelineArtifactRepresentation,
} from "./timeline-artifacts.js";

export { VEGA_LITE_MIME } from "./timeline-artifacts.js";
export type {
  TimelineArtifact,
  TimelineArtifactDetails,
  TimelineArtifactRepresentation,
} from "./timeline-artifacts.js";

export interface TimelineImage {
  readonly id: string;
  readonly src: string;
  readonly alt?: string;
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

// A timeline can contain thousands of history rows after the user pages back
// through a long session. Rows are intentionally not fixed-height: markdown,
// tool output, images, and artifact cards all grow independently. Keep a
// generously overscanned, measured window of *turns* in the DOM and represent
// the rest with inert spacers. Turns (rather than individual records) are the
// unit so a reply, its tool cards, and its footer never get separated.
const VIRTUALIZE_AFTER_TURNS = 40;
const VIRTUAL_OVERSCAN_PX = 1_200;
const ESTIMATED_TURN_HEIGHT_PX = 156;
const TURN_GAP_PX = 12;

interface VirtualViewport {
  readonly scrollTop: number;
  readonly height: number;
}

interface VirtualTurnProps {
  readonly turn: TurnGroup;
  readonly turnIndex: number;
  readonly totalTurns: number;
  readonly hideThinking: boolean;
  readonly enabledArtifactMimes: readonly string[] | undefined;
  readonly showFooter: boolean;
  readonly onHeight: (key: string, height: number) => void;
}

/** A measured turn wrapper. ResizeObserver handles late image/artifact loads
 * and expanding tool cards; the estimate is only used until this reports. */
function VirtualTurn({ turn, turnIndex, totalTurns, hideThinking, enabledArtifactMimes, showFooter, onHeight }: VirtualTurnProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const key = turn.messages[0]?.id ?? `turn-${turnIndex}`;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const report = () => {
      const contentHeight = node.getBoundingClientRect().height;
      // Hidden/detached nodes and jsdom report zero; retain the estimate until
      // a real layout measurement is available rather than collapsing a turn.
      if (contentHeight > 0) onHeight(key, contentHeight + (turnIndex === totalTurns - 1 ? 0 : TURN_GAP_PX));
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [key, onHeight, totalTurns, turnIndex]);

  return (
    <div
      ref={ref}
      className="timeline-turn timeline-turn-virtual"
      role="group"
      aria-label={`Messages ${turnIndex + 1} of ${totalTurns}`}
    >
      {turn.messages.map((message) => renderMessage(message, hideThinking, enabledArtifactMimes))}
      {showFooter && turn.messages.length > 0 ? <TurnFooter turn={turn} /> : null}
    </div>
  );
}

export function MessageTimeline({ messages, hideThinking = false, autoScroll = true, streaming = false, enabledArtifactMimes, sessionId, hasMoreOlder = false, loadingOlder = false, onLoadOlder }: MessageTimelineProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const [viewport, setViewport] = useState<VirtualViewport>({ scrollTop: 0, height: 0 });
  // Heights are keyed by a stable first-message id, so a prepend does not
  // invalidate measurements for the already-loaded tail.
  const turnHeightsRef = useRef(new Map<string, number>());
  const [heightRevision, setHeightRevision] = useState(0);

  function updateViewport(el = containerRef.current) {
    if (!el) return;
    const next = { scrollTop: el.scrollTop, height: el.clientHeight };
    setViewport((previous) => previous.scrollTop === next.scrollTop && previous.height === next.height ? previous : next);
  }

  function recordTurnHeight(key: string, height: number) {
    if (height <= 0) return;
    const previous = turnHeightsRef.current.get(key);
    // ResizeObserver can report fractional noise while a markdown/image card
    // settles. Avoid rerendering the window for imperceptible changes.
    if (previous != null && Math.abs(previous - height) < 1) return;
    turnHeightsRef.current.set(key, height);
    setHeightRevision((revision) => revision + 1);
  }

  // Seed the first window with the actual viewport even if auto-scroll is
  // disabled (for example when reading a restored session).
  useLayoutEffect(() => { updateViewport(); }, []);

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
  // Assign during render rather than in an effect: a user can scroll before
  // passive effects flush after a pagination rerender, and that must still use
  // the current callback/cursors.
  onLoadOlderRef.current = onLoadOlder;
  hasMoreOlderRef.current = hasMoreOlder;
  loadingOlderRef.current = loadingOlder;

  useEffect(() => { pinnedRef.current = pinned; }, [pinned]);

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) {
      endRef.current?.scrollIntoView?.({ block: "end" });
      return;
    }
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    updateViewport(el);
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
      updateViewport(el);
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
    updateViewport(el);
    restoreDistanceFromBottomRef.current = null;
  }, [messages, loadingOlder]);

  const turns = groupTurns(messages);
  const virtualized = turns.length > VIRTUALIZE_AFTER_TURNS;
  const virtualWindow = useMemo(() => {
    if (!virtualized) return { start: 0, end: turns.length, top: 0, bottom: 0 };
    const heights = turns.map((turn, index) => turnHeightsRef.current.get(turn.messages[0]?.id ?? `turn-${index}`) ?? ESTIMATED_TURN_HEIGHT_PX);
    const total = heights.reduce((sum, height) => sum + height, 0);
    const startAt = Math.max(0, viewport.scrollTop - VIRTUAL_OVERSCAN_PX);
    const endAt = viewport.scrollTop + Math.max(viewport.height, 1) + VIRTUAL_OVERSCAN_PX;
    let start = 0;
    let offset = 0;
    while (start < heights.length && offset + heights[start]! < startAt) offset += heights[start++]!;
    let end = start;
    let renderedHeight = offset;
    while (end < heights.length && renderedHeight < endAt) renderedHeight += heights[end++]!;
    // Always leave a non-empty window, including in layout-less test DOMs.
    end = Math.max(end, Math.min(turns.length, start + 1));
    return { start, end, top: offset, bottom: Math.max(0, total - renderedHeight) };
  // Height revisions deliberately cause the variable-height prefix sums to be
  // recomputed; the map itself stays in a ref to avoid copying thousands of rows.
  }, [turns, virtualized, viewport, heightRevision]);

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
      <div className={`message-timeline-inner${virtualized ? " is-virtualized" : ""}`} ref={innerRef}>
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
        {virtualWindow.top > 0 ? <div className="timeline-virtual-spacer" aria-hidden="true" style={{ height: virtualWindow.top }} /> : null}
        {turns.slice(virtualWindow.start, virtualWindow.end).map((turn, localIndex) => {
          const turnIndex = virtualWindow.start + localIndex;
          const isLatest = turnIndex === turns.length - 1;
          const showFooter = !isLatest || !streaming;
          if (virtualized) {
            return <VirtualTurn
              key={`turn-${turn.messages[0]?.id ?? turnIndex}`}
              turn={turn}
              turnIndex={turnIndex}
              totalTurns={turns.length}
              hideThinking={hideThinking}
              enabledArtifactMimes={enabledArtifactMimes}
              showFooter={showFooter}
              onHeight={recordTurnHeight}
            />;
          }
          return (
            <div key={`turn-${turn.messages[0]?.id ?? turnIndex}`} className="timeline-turn">
              {turn.messages.map((message) => renderMessage(message, hideThinking, enabledArtifactMimes))}
              {showFooter && turn.messages.length > 0 ? <TurnFooter turn={turn} /> : null}
            </div>
          );
        })}
        {virtualWindow.bottom > 0 ? <div className="timeline-virtual-spacer" aria-hidden="true" style={{ height: virtualWindow.bottom }} /> : null}
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
  // An active invocation is the one moment where the conversation must be
  // self-explanatory: surface its small live tail without making the reader
  // open a disclosure. Native <details> remains controlled by this state, so
  // a deliberate close stays closed across every later SSE update.
  const [open, setOpen] = useState(() => tool.status === "running");
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
            {tool.status === "running" ? <LiveToolOutputTail output={tool.output} /> : <ToolResultBody tool={tool} />}
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
const LIVE_TOOL_TAIL_LINES = 4;

/**
 * Selects terminal output by logical line without normalizing away blank
 * lines. A trailing newline is itself an empty terminal line, so it remains
 * meaningful in the live preview.
 */
export function tailToolOutput(output: string, lines = LIVE_TOOL_TAIL_LINES): string {
  return output.split(/\r?\n/).slice(-lines).join("\n");
}

function LiveToolOutputTail({ output }: { readonly output: string }) {
  if (!output) return <p className="tool-waiting-output">Waiting for output…</p>;
  return (
    <section
      className="tool-live-output"
      role="status"
      aria-label={`Live output (last ${LIVE_TOOL_TAIL_LINES} lines)`}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="tool-live-output-label">Live output (last {LIVE_TOOL_TAIL_LINES} lines)</span>
      <pre className="tool-output">{tailToolOutput(output)}</pre>
    </section>
  );
}

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
    if (typeof value === "string" && value.trim()) return truncateWithEllipsis(value, 80);
  }
  return "";
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
          table(props) {
            // Keep a Markdown table's columns legible on narrow screens.
            // The local, keyboard-focusable viewport lets the user pan the
            // table instead of shrinking its first column character by
            // character (and avoids creating page-level horizontal overflow).
            return (
              <div className="markdown-table-scroll" role="region" aria-label="Scrollable markdown table" tabIndex={0}>
                <table>{props.children}</table>
              </div>
            );
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
