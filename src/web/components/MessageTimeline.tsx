import { useEffect, useRef } from "react";
import "./message-timeline.css";

export interface TimelineImage {
  readonly id: string;
  readonly src: string;
  readonly alt?: string;
}

export interface TimelineMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "custom" | "summary";
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
}

export interface MessageTimelineProps {
  readonly messages: readonly TimelineMessage[];
  readonly hideThinking?: boolean;
  readonly autoScroll?: boolean;
}

export function MessageTimeline({ messages, hideThinking = false, autoScroll = true }: MessageTimelineProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ block: "end" });
  }, [autoScroll, messages.length]);

  return (
    <section className="message-timeline" aria-label="Message timeline">
      {messages.map((message) => (
        <article key={message.id} className={`message-card ${message.role}`} aria-label={`${message.role} message`}>
          <header className="message-header">
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
            <details className="thinking-block" open>
              <summary>Thinking</summary>
              <pre>{message.thinking}</pre>
            </details>
          ) : null}

          <MarkdownLite text={message.text} />

          {message.error ? <p role="alert" className="message-error">{message.error}</p> : null}

          <footer className="message-footer">
            {message.provider ? <span>{message.provider}</span> : null}
            {message.model ? <span>{message.model}</span> : null}
            {message.stopReason ? <span>{message.stopReason}</span> : null}
            {message.tokenUsage ? <span>{message.tokenUsage}</span> : null}
            {message.cost ? <span>{message.cost}</span> : null}
            <button type="button" onClick={() => void copyText(message.text)}>Copy</button>
          </footer>
        </article>
      ))}
      <div ref={endRef} data-testid="timeline-end" />
    </section>
  );
}

function messageTitle(message: TimelineMessage): string {
  if (message.role === "custom") return message.customLabel ?? "Extension";
  if (message.role === "summary") return message.summaryKind === "branch" ? "Branch summary" : "Compaction summary";
  return message.role === "assistant" ? "Assistant" : "You";
}

function MarkdownLite({ text }: { readonly text: string }) {
  const parts = parseMarkdownLite(text);
  return (
    <div className="markdown-lite">
      {parts.map((part, index) => {
        if (part.type === "heading") return <h3 key={index}>{part.text}</h3>;
        if (part.type === "code") {
          return (
            <div key={index} className="code-block">
              <button type="button" onClick={() => void copyText(part.text)}>Copy code</button>
              <pre><code>{part.text}</code></pre>
            </div>
          );
        }
        return <p key={index}>{part.text}</p>;
      })}
    </div>
  );
}

type MarkdownPart =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "heading"; readonly text: string }
  | { readonly type: "code"; readonly text: string };

function parseMarkdownLite(text: string): MarkdownPart[] {
  const lines = text.split("\n");
  const parts: MarkdownPart[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  function flushParagraph() {
    const joined = paragraph.join("\n").trim();
    if (joined) parts.push({ type: "paragraph", text: joined });
    paragraph = [];
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code) {
        parts.push({ type: "code", text: code.join("\n") });
        code = null;
      } else {
        flushParagraph();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (line.startsWith("# ") || line.startsWith("## ") || line.startsWith("### ")) {
      flushParagraph();
      parts.push({ type: "heading", text: line.replace(/^#{1,3}\s+/, "") });
      continue;
    }
    if (line.trim() === "") flushParagraph();
    else paragraph.push(line);
  }
  if (code) parts.push({ type: "code", text: code.join("\n") });
  flushParagraph();
  return parts.length ? parts : [{ type: "paragraph", text: "" }];
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard?.writeText(text);
}
