import { useEffect, useMemo, useRef, useState } from "react";
import "./prompt-composer.css";

export interface ComposerAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: "image" | "file";
  readonly previewUrl?: string;
}

export interface PromptComposerProps {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly steeringQueue: readonly string[];
  readonly followUpQueue: readonly string[];
  readonly fileSuggestions: readonly string[];
  readonly commandSuggestions: readonly string[];
  readonly onPrompt: (text: string, attachments: readonly ComposerAttachment[]) => void | Promise<void>;
  readonly onSteer: (text: string) => void | Promise<void>;
  readonly onFollowUp: (text: string) => void | Promise<void>;
  readonly onAbort: () => void | Promise<void>;
  readonly onBash: (command: string, includeInContext: boolean) => void | Promise<void>;
  readonly onAbortBash?: () => void | Promise<void>;
  readonly onSlashCommand?: (name: string, argv: string) => void | Promise<void>;
}

export function PromptComposer(props: PromptComposerProps) {
  const storageKey = `draft:${props.sessionId}`;
  const [draft, setDraft] = useState(() => storageGet(storageKey) ?? "");
  const [history, setHistory] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(storageGet(storageKey) ?? "");
  }, [storageKey]);

  useEffect(() => {
    storageSet(storageKey, draft);
  }, [draft, storageKey]);

  const mode = draft.startsWith("!!") ? "hidden-bash" : draft.startsWith("!") ? "bash" : "prompt";
  const activeToken = draft.split(/\s/).at(-1) ?? "";
  const fileMatches = activeToken.startsWith("@")
    ? props.fileSuggestions.filter((file) => file.toLowerCase().includes(activeToken.slice(1).toLowerCase()))
    : [];
  const commandMatches = draft.startsWith("/")
    ? props.commandSuggestions.filter((command) => command.toLowerCase().includes(draft.slice(1).toLowerCase()))
    : [];

  const queueSummary = useMemo(() => [
    ...props.steeringQueue.map((item) => `Steer: ${item}`),
    ...props.followUpQueue.map((item) => `Follow-up: ${item}`),
  ], [props.followUpQueue, props.steeringQueue]);

  async function submit(kind?: "steer" | "follow-up") {
    const text = draft.trim();
    if (!text) return;
    setHistory((current) => [text, ...current]);
    setDraft("");
    if (mode === "bash" || mode === "hidden-bash") {
      await props.onBash(mode === "hidden-bash" ? text.slice(2) : text.slice(1), mode === "bash");
      setAttachments([]);
      return;
    }
    if (text.startsWith("/") && props.onSlashCommand) {
      const trimmed = text.slice(1);
      const spaceIndex = trimmed.indexOf(" ");
      const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
      const argv = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1);
      await props.onSlashCommand(name, argv);
      setAttachments([]);
      return;
    }
    if (kind === "steer") await props.onSteer(text);
    else if (kind === "follow-up") await props.onFollowUp(text);
    else if (props.isStreaming) await props.onSteer(text);
    else await props.onPrompt(text, attachments);
    setAttachments([]);
  }

  function completeFile(file: string) {
    setDraft((current) => current.replace(/@\S*$/, `@${file}`));
  }

  function completeCommand(command: string) {
    setDraft(`/${command}`);
  }

  function pathComplete() {
    if (!activeToken) return;
    const needle = activeToken.replace(/^@/, "").toLowerCase();
    const match = props.fileSuggestions.find((file) => file.toLowerCase().startsWith(needle));
    if (match) {
      setDraft((current) => current.replace(/\S*$/, `@${match}`));
    }
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    setAttachments((current) => [
      ...current,
      ...Array.from(files).map((file): ComposerAttachment => ({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type.startsWith("image/") ? "image" : "file",
        ...(file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
      })),
    ]);
  }

  const placeholder = mode === "bash"
    ? "Run a shell command (! prefix)"
    : mode === "hidden-bash"
      ? "Hidden shell command (!! prefix)"
      : "Type / for commands";

  return (
    <section className={`prompt-composer ${mode}`} aria-label="Prompt composer">
      <div className="composer-input">
        <textarea
          aria-label="Prompt draft"
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.altKey) {
              event.preventDefault();
              void submit("follow-up");
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
              return;
            }
            if (event.key === "Escape" && props.isStreaming) {
              event.preventDefault();
              void props.onAbort();
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              pathComplete();
              return;
            }
            if (event.key === "ArrowUp" && event.altKey && history[0]) {
              event.preventDefault();
              setDraft(history[0]);
            }
          }}
          onPaste={(event) => addFiles(event.clipboardData.files)}
          onDrop={(event) => {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }}
          onDragOver={(event) => event.preventDefault()}
        />
        <button
          type="button"
          className="composer-send"
          aria-label="Send"
          disabled={!draft.trim()}
          onClick={() => void submit()}
        >
          <SendGlyph />
        </button>
      </div>

      {fileMatches.length ? <SuggestionList label="File suggestions" items={fileMatches} onPick={completeFile} /> : null}
      {commandMatches.length ? <SuggestionList label="Command suggestions" items={commandMatches} onPick={completeCommand} /> : null}

      <input
        ref={fileInputRef}
        type="file"
        aria-label="Attach files"
        multiple
        hidden
        onChange={(event) => {
          addFiles(event.target.files);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />

      {attachments.length ? (
        <ul className="attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              {attachment.previewUrl ? <img src={attachment.previewUrl} alt={attachment.name} /> : null}
              <span>{attachment.name}</span>
              <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>Remove</button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="composer-meta">
        <button type="button" className="composer-icon" aria-label="Add attachment" onClick={() => fileInputRef.current?.click()}>
          <PaperclipGlyph />
        </button>

        {mode !== "prompt" ? <span className="composer-mode">{mode === "bash" ? "shell" : "hidden shell"}</span> : null}

        {props.isStreaming ? (
          <span className="composer-streaming" aria-live="polite">Agent is working…</span>
        ) : null}

        <span className="composer-spacer" />

        {props.isStreaming ? (
          <>
            <button type="button" className="composer-text-action danger" onClick={() => void props.onAbort()}>Abort</button>
            <button type="button" className="composer-text-action" onClick={() => void submit("follow-up")}>Follow-up</button>
          </>
        ) : null}
      </div>

      {queueSummary.length ? (
        <ul aria-label="Message queues" className="composer-queues">
          {queueSummary.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      ) : null}

      <p className="composer-hint" aria-hidden="true">
        <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>Alt+Enter</kbd> follow-up{props.isStreaming ? <> · <kbd>Esc</kbd> abort</> : null} · <kbd>Alt+↑</kbd> history
      </p>
    </section>
  );
}

function SuggestionList({ label, items, onPick }: { readonly label: string; readonly items: readonly string[]; readonly onPick: (item: string) => void }) {
  return (
    <ul aria-label={label} className="suggestions">
      {items.map((item) => <li key={item}><button type="button" onClick={() => onPick(item)}>{item}</button></li>)}
    </ul>
  );
}

function SendGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 4v4a3 3 0 0 1-3 3H3.5" />
      <path d="M6 8.5 3 11l3 2.5" />
    </svg>
  );
}

function PaperclipGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.5 6.5 7.4 11.6a2.2 2.2 0 1 1-3.1-3.1l5.6-5.6a3.3 3.3 0 0 1 4.7 4.7l-6 6a4.4 4.4 0 0 1-6.2-6.2L7.6 2.6" />
    </svg>
  );
}

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.setItem !== "function") return;
    localStorage.setItem(key, value);
  } catch {
    // Ignore unavailable storage. Draft persistence is best-effort.
  }
}
