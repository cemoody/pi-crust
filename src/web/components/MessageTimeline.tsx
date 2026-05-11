import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./message-timeline.css";

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
  if (message.role === "tool" && message.tool) {
    return <ToolCard key={message.id} tool={message.tool} />;
  }
  const showLabel = message.role === "custom" || message.role === "summary";
  return (
    <article key={message.id} className={`message-card ${message.role}`} aria-label={`${message.role} message`}>
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

      <div className="message-bubble">
        <MarkdownLite text={message.text} />
      </div>

      {message.error ? <p role="alert" className="message-error">{message.error}</p> : null}

      <footer className="message-footer is-hidden">
        {message.provider ? <span>{message.provider}</span> : null}
        {message.model ? <span>{message.model}</span> : null}
        {message.stopReason ? <span>{message.stopReason}</span> : null}
        {message.tokenUsage ? <span>{message.tokenUsage}</span> : null}
        {message.cost ? <span>{message.cost}</span> : null}
        <button type="button" onClick={() => void copyText(message.text)}>Copy</button>
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
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function handleCopy() {
    const markdown = turnToMarkdown(turn);
    await copyText(markdown);
    setCopied(true);
  }

  return (
    <div className="turn-footer" aria-label="Turn actions">
      <button type="button" className="turn-copy" aria-label="Copy turn as markdown" onClick={() => void handleCopy()}>
        <ClipboardGlyph />
      </button>
      {copied ? <span className="turn-copied" role="status">copied</span> : null}
      {turn.lastTimestamp ? <span className="turn-age" title={new Date(turn.lastTimestamp).toLocaleString()}>{relativeTime(turn.lastTimestamp, now)}</span> : null}
    </div>
  );
}

function ClipboardGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="8" height="10" rx="1.5" />
      <path d="M6 3v-.5A1.5 1.5 0 0 1 7.5 1h1A1.5 1.5 0 0 1 10 2.5V3" />
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

function ToolCard({ tool }: { readonly tool: TimelineToolDetails }) {
  return (
    <details className={`tool-card ${tool.status}`} aria-label={`tool ${tool.name}`}>
      <summary>
        <span className="tool-icon" aria-hidden="true">{toolIcon(tool.status)}</span>
        <span className="tool-line">
          <strong>{verbForName(tool.name)}</strong> <code>{tool.name}</code>
          {summarizeArgs(tool.args) ? <> · <span className="tool-args">{summarizeArgs(tool.args)}</span></> : null}
        </span>
        <span className="tool-status-text">{statusLabel(tool.status)}</span>
      </summary>
      {tool.output ? <pre>{tool.output}</pre> : null}
    </details>
  );
}

function toolIcon(status: TimelineToolDetails["status"]): string {
  if (status === "running") return "•";
  if (status === "error") return "✕";
  return "✓";
}

function statusLabel(status: TimelineToolDetails["status"]): string {
  if (status === "running") return "running…";
  if (status === "error") return "failed";
  return "done";
}

function verbForName(name: string): string {
  if (name === "bash") return "Ran";
  if (name === "read") return "Read";
  if (name === "edit") return "Edited";
  if (name === "write") return "Wrote";
  if (name === "grep") return "Searched";
  if (name === "find") return "Found";
  if (name === "ls") return "Listed";
  return "Ran";
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
                <button type="button" onClick={() => void copyText(value)}>Copy code</button>
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

async function copyText(text: string): Promise<void> {
  await navigator.clipboard?.writeText(text);
}
