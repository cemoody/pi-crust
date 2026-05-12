import { Suspense, lazy, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  readonly kind: "image" | "html" | "markdown" | "json" | "table" | "vega-lite" | string;
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
}

export function MessageTimeline({ messages, hideThinking = false, autoScroll = true, streaming = false }: MessageTimelineProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoScroll && typeof endRef.current?.scrollIntoView === "function") {
      endRef.current.scrollIntoView({ block: "end" });
    }
  }, [autoScroll, messages]);

  const turns = groupTurns(messages);

  return (
    <section className="message-timeline" aria-label="Message timeline">
      <div className="message-timeline-inner">
        {turns.map((turn, turnIndex) => {
          const isLatest = turnIndex === turns.length - 1;
          const showFooter = !isLatest || !streaming;
          return (
            <div key={`turn-${turn.messages[0]?.id ?? turnIndex}`} className="timeline-turn">
              {turn.messages.map((message) => renderMessage(message, hideThinking))}
              {showFooter && turn.messages.length > 0 ? <TurnFooter turn={turn} /> : null}
            </div>
          );
        })}
        {streaming ? <TypingDots /> : null}
        <div ref={endRef} data-testid="timeline-end" />
      </div>
    </section>
  );
}

function renderMessage(message: TimelineMessage, hideThinking: boolean) {
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
        <details className="thinking-block">
          <summary>Thinking</summary>
          <pre>{message.thinking}</pre>
        </details>
      ) : null}

      {isArtifact ? (
        <ArtifactView artifact={message.artifact!} fallbackText={message.text} />
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

function lastAssistantTextOf(turn: TurnGroup): string {
  for (let i = turn.messages.length - 1; i >= 0; i--) {
    const message = turn.messages[i];
    if (message && message.role === "assistant" && message.text.trim()) {
      return message.text.trim();
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
    if (message.role === "user") {
      parts.push(`**You:**\n\n${message.text.trim()}`);
    } else if (message.role === "assistant") {
      parts.push(`**Assistant:**\n\n${message.text.trim()}`);
    } else if (message.role === "tool" && message.tool) {
      const tool = message.tool;
      const args = Object.keys(tool.args).length > 0 ? `\n\n\`\`\`json\n${JSON.stringify(tool.args, null, 2)}\n\`\`\`` : "";
      const output = tool.output ? `\n\n\`\`\`\n${tool.output}\n\`\`\`` : "";
      parts.push(`**Tool · ${tool.name}** _(${tool.status})_${args}${output}`);
    } else if (message.role === "summary") {
      const kind = message.summaryKind === "branch" ? "Branch summary" : "Compaction summary";
      parts.push(`**${kind}:**\n\n${message.text.trim()}`);
    } else {
      parts.push(`_${message.customLabel ?? message.role}:_ ${message.text.trim()}`);
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
  return (
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
      {tool.output ? <pre>{tool.output}</pre> : null}
      {tool.artifact ? <ArtifactPreview artifact={tool.artifact} /> : null}
    </details>
  );
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
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.markdown}</ReactMarkdown>
      </section>
    );
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
}: {
  readonly artifact: TimelineArtifactDetails;
  readonly fallbackText: string;
}) {
  const caption = artifact.caption;
  const rendered = pickRenderableRepresentation(artifact.artifacts);

  return (
    <figure className="artifact-view" aria-label={caption ?? "Artifact"}>
      {caption ? <figcaption className="artifact-caption">{caption}</figcaption> : null}
      {rendered ?? <ArtifactPlainFallback artifacts={artifact.artifacts} message={fallbackText} />}
    </figure>
  );
}

function pickRenderableRepresentation(
  reps: readonly TimelineArtifactRepresentation[],
): React.ReactNode | null {
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
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSeconds}s`;
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

function MarkdownLite({ text }: { readonly text: string }) {
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
        {text}
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
