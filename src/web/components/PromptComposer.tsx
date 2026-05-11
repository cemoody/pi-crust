import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_PROMPT_CHARS } from "../../shared/limits.js";
import "./prompt-composer.css";

export interface ComposerAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: "image" | "file";
  readonly mimeType?: string;
  readonly data?: string;
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
  readonly statusText?: string;
  readonly statusCwd?: string;
  readonly statusModel?: string;
  readonly statusTokens?: string;
}

export function PromptComposer(props: PromptComposerProps) {
  const storageKey = `draft:${props.sessionId}`;
  const [draft, setDraft] = useState(() => storageGet(storageKey) ?? "");
  const [history, setHistory] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [pasteWarning, setPasteWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!pasteWarning) return;
    const t = setTimeout(() => setPasteWarning(null), 6_000);
    return () => clearTimeout(t);
  }, [pasteWarning]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(storageGet(storageKey) ?? "");
  }, [storageKey]);

  useEffect(() => {
    storageSet(storageKey, draft);
  }, [draft, storageKey]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

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
    else if (props.isStreaming) await props.onFollowUp(text);
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

  async function addFiles(files: FileList | readonly File[] | null) {
    if (!files) return;
    const next = await Promise.all(Array.from(files).map(async (file): Promise<ComposerAttachment> => {
      const isImage = file.type.startsWith("image/");
      const data = isImage ? await fileToBase64(file) : undefined;
      return {
        id: crypto.randomUUID(),
        name: file.name || (isImage ? "pasted image" : "attachment"),
        type: isImage ? "image" : "file",
        ...(file.type ? { mimeType: file.type } : {}),
        ...(data === undefined ? {} : { data, previewUrl: `data:${file.type};base64,${data}` }),
      };
    }));
    setAttachments((current) => [...current, ...next]);
  }

  const placeholder = mode === "bash"
    ? "Run a shell command (! prefix)"
    : mode === "hidden-bash"
      ? "Hidden shell command (!! prefix)"
      : "Type / for commands";

  return (
    <section className={`prompt-composer ${mode}`} aria-label="Prompt composer">
      <div className="composer-input">
        <button
          type="button"
          className="composer-attach"
          aria-label="Add attachment"
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipGlyph />
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
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
          onPaste={(event) => {
            const files = clipboardFiles(event.clipboardData);
            if (files.length > 0) {
              event.preventDefault();
              setPasteWarning(null);
              void addFiles(files);
              return;
            }
            const text = event.clipboardData.getData("text");
            if (looksLikeImageData(text)) {
              event.preventDefault();
              setPasteWarning(`Clipboard looks like raw image data (${text.length.toLocaleString()} chars). Use the paperclip or paste a real screenshot to attach it as an image.`);
              return;
            }
            if (text.length > MAX_PROMPT_CHARS - draft.length) {
              event.preventDefault();
              setPasteWarning(`Paste blocked: ${text.length.toLocaleString()} chars would exceed the ${MAX_PROMPT_CHARS.toLocaleString()}-char limit.`);
              return;
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            void addFiles(event.dataTransfer.files);
          }}
          onDragOver={(event) => event.preventDefault()}
        />
        {props.isStreaming && !draft.trim() ? (
          <button
            type="button"
            className="composer-send composer-stop"
            aria-label="Abort"
            onClick={() => void props.onAbort()}
          >
            <StopGlyph />
          </button>
        ) : (
          <button
            type="button"
            className="composer-send"
            aria-label="Send"
            disabled={!draft.trim()}
            onClick={() => void submit()}
          >
            <SendGlyph />
          </button>
        )}
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
          void addFiles(event.target.files);
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

      {pasteWarning ? (
        <div className="composer-paste-warning" role="status">
          <span>{pasteWarning}</span>
          <button type="button" onClick={() => setPasteWarning(null)} aria-label="Dismiss paste warning">×</button>
        </div>
      ) : null}

      <div className="composer-meta" aria-label="Session status">
        {mode !== "prompt" ? <span className="composer-mode">{mode === "bash" ? "shell" : "hidden shell"}</span> : null}

        <span className="composer-status">
          {props.statusText ? <span className="chip">{props.statusText}</span> : null}
          {props.statusCwd ? <><span className="sep">·</span><span className="chip" title={props.statusCwd}>{shortPath(props.statusCwd, 32)}</span></> : null}
          <span className="sep">·</span>
          {props.statusModel && props.onSlashCommand ? (
            <button
              type="button"
              className="chip composer-status-model"
              title={`${props.statusModel} — click to change`}
              onClick={() => void props.onSlashCommand?.("model", "")}
            >
              {shortModel(props.statusModel, 24)}
            </button>
          ) : (
            <span className="chip" title={props.statusModel ?? undefined}>
              {props.statusModel ? shortModel(props.statusModel, 24) : "no model selected"}
            </span>
          )}
          <span className="sep">·</span><span className="chip">{props.statusTokens ?? "0 tokens"}</span>
        </span>
      </div>

      {queueSummary.length ? (
        <ul aria-label="Message queues" className="composer-queues">
          {queueSummary.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (files.length > 0) return files;
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function looksLikeImageData(text: string): boolean {
  if (text.length < 1024) return false;
  const head = text.slice(0, 512);
  if (/data:image\/(png|jpe?g|gif|webp);base64,/i.test(head)) return true;
  if (/iVBORw0KGgo/.test(head)) return true; // PNG magic in base64
  if (/\/9j\/[A-Za-z0-9+/]{20,}/.test(head)) return true; // JPEG magic in base64
  if (/"type"\s*:\s*"image"/i.test(head) && /"data"\s*:\s*"[A-Za-z0-9+/=]{100,}/.test(text)) return true;
  return false;
}

function shortPath(value: string, max?: number): string {
  const segments = value.split("/").filter(Boolean);
  const shortened = segments.length <= 2 ? value : `…/${segments.slice(-2).join("/")}`;
  if (max === undefined || shortened.length <= max) return shortened;
  return `…${shortened.slice(shortened.length - max + 1)}`;
}

function shortModel(value: string, max: number): string {
  if (value.length <= max) return value;
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex !== -1) {
    const tail = value.slice(slashIndex + 1);
    if (tail.length + 2 <= max) return `…/${tail}`;
    return `…${tail.slice(tail.length - max + 1)}`;
  }
  return `…${value.slice(value.length - max + 1)}`;
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

function StopGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" rx="2.5" />
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
