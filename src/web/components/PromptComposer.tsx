import { type ClipboardEvent as ReactClipboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { MAX_PROMPT_CHARS } from "../../shared/limits.js";
import { errorMessage, optional } from "../../shared/util.js";
import { downscaleImageIfNeeded } from "../utils/image-downscale.js";
import "./prompt-composer.css";
import { Icon } from "./Icon.js";
import {
  attachmentId,
  clipboardFiles,
  clipboardImageMimeType,
  fileToBase64WithReader,
  hasClipboardImageType,
  imageAttachmentFromRawBase64,
  imageAttachmentFromText,
  imageAttachmentsFromHtml,
  isBase64Blob,
  isEditablePasteTarget,
  looksLikeImageData,
} from "./prompt-composer-clipboard.js";
export type { ComposerAttachment } from "./prompt-composer-clipboard.js";
import type { ComposerAttachment } from "./prompt-composer-clipboard.js";

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
  readonly draftSeed?: { readonly id: string; readonly value: string };
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

  // Monotonic generation counter for attachment state. Bumped every time
  // the local attachments list is cleared (on submit or session change).
  // In-flight async paths (image downscale, paste, etc.) capture the gen
  // at start and drop their result if it no longer matches — prevents a
  // late-resolving paste from "popping back" into the composer after the
  // user already submitted.
  const attachmentGenRef = useRef(0);

  function clearAttachments() {
    attachmentGenRef.current += 1;
    setAttachments([]);
  }

  useEffect(() => {
    if (!pasteWarning) return;
    const t = setTimeout(() => setPasteWarning(null), 6_000);
    return () => clearTimeout(t);
  }, [pasteWarning]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setDraft(storageGet(storageKey) ?? "");
    // Attachments are not session-scoped, so changing sessions must drop
    // the previous session's pending attachments. Otherwise the user
    // reports the image "stays attached" after navigating to another
    // session and has to click Remove manually.
    clearAttachments();
  }, [storageKey]);

  useEffect(() => {
    if (!props.draftSeed) return;
    setDraft(props.draftSeed.value);
    textareaRef.current?.focus({ preventScroll: true });
  }, [props.draftSeed]);

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
    if (!text && attachments.length === 0) return;
    if (text) setHistory((current) => [text, ...current]);
    setDraft("");
    if (mode === "bash" || mode === "hidden-bash") {
      await props.onBash(mode === "hidden-bash" ? text.slice(2) : text.slice(1), mode === "bash");
      clearAttachments();
      return;
    }
    if (text.startsWith("/") && props.onSlashCommand) {
      const trimmed = text.slice(1);
      const spaceIndex = trimmed.indexOf(" ");
      const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
      const argv = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1);
      await props.onSlashCommand(name, argv);
      clearAttachments();
      return;
    }
    // Capture the attachments snapshot before clearing them locally so
    // an in-flight onPrompt's await doesn't see them mutate underneath.
    const snapshot = attachments;
    clearAttachments();
    if (kind === "steer") await props.onSteer(text);
    else if (kind === "follow-up") await props.onFollowUp(text);
    else if (props.isStreaming) await props.onFollowUp(text);
    else await props.onPrompt(text, snapshot);
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
    // Snapshot the attachment generation at the start of the user-visible
    // operation. If a submit/clear bumps it before file processing finishes,
    // we drop the results so a slow-resolving paste can't pop back into the
    // composer after the user has already sent.
    const gen = attachmentGenRef.current;
    const results = await Promise.allSettled(Array.from(files).map(fileToAttachment));
    if (gen !== attachmentGenRef.current) return;
    const next = results
      .filter((result): result is PromiseFulfilledResult<ComposerAttachment> => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    if (next.length > 0) {
      void addAttachments(next, gen);
      if (failures.length > 0) {
        setPasteWarning(`Attached ${next.length} item${next.length === 1 ? "" : "s"}, but could not read ${failures.length} other pasted item${failures.length === 1 ? "" : "s"}.`);
      } else {
        setPasteWarning(null);
      }
      return;
    }

    const firstFailure = failures[0];
    if (firstFailure) {
      const detail = errorMessage(firstFailure.reason);
      console.warn("Unable to read pasted file", firstFailure.reason);
      setPasteWarning(`Could not read that pasted file${detail ? ` (${detail})` : ""}. Try the paperclip button, or open Pi Remote Control through localhost/HTTPS if your browser is blocking clipboard image data.`);
    }
  }

  async function fileToAttachment(file: File): Promise<ComposerAttachment> {
    const isImage = file.type.startsWith("image/");
    let data = await fileToBase64(file);
    let mimeType = file.type || (isImage ? "image/png" : undefined);
    if (isImage && data && mimeType) {
      const shrunk = await downscaleImageIfNeeded({ data, mimeType });
      data = shrunk.data;
      mimeType = shrunk.mimeType;
    }
    return {
      id: attachmentId(),
      name: file.name || (isImage ? "pasted image" : "attachment"),
      type: isImage ? "image" : "file",
      ...(mimeType ? { mimeType } : {}),
      ...optional({ data }),
      ...(isImage && data !== undefined ? { previewUrl: `data:${mimeType};base64,${data}` } : {}),
    };
  }

  async function addAttachments(next: readonly ComposerAttachment[], sourceGen?: number) {
    if (next.length === 0) return;
    // The optional sourceGen lets callers (addFiles, handleClipboardPaste)
    // pin the gen they captured at the start of the user gesture. If they
    // don't pass one we snapshot here.
    const gen = sourceGen ?? attachmentGenRef.current;
    const shrunk = await Promise.all(next.map(maybeShrinkAttachment));
    if (gen !== attachmentGenRef.current) return;
    setAttachments((current) => [...current, ...shrunk]);
    setPasteWarning(null);
  }

  async function maybeShrinkAttachment(attachment: ComposerAttachment): Promise<ComposerAttachment> {
    if (attachment.type !== "image" || !attachment.data || !attachment.mimeType) return attachment;
    const result = await downscaleImageIfNeeded({ data: attachment.data, mimeType: attachment.mimeType });
    if (!result.downscaled) return attachment;
    return {
      ...attachment,
      data: result.data,
      mimeType: result.mimeType,
      previewUrl: `data:${result.mimeType};base64,${result.data}`,
    };
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    await handleClipboardPaste(event.clipboardData, () => event.preventDefault(), false);
  }

  async function handleClipboardPaste(data: DataTransfer, preventDefault: () => void, insertTextWhenNotFocused: boolean) {
    const gen = attachmentGenRef.current;
    const files = clipboardFiles(data);
    if (files.length > 0) {
      preventDefault();
      await addFiles(files);
      return;
    }

    const htmlAttachments = imageAttachmentsFromHtml(data.getData("text/html"));
    if (htmlAttachments.length > 0) {
      preventDefault();
      void addAttachments(htmlAttachments, gen);
      return;
    }

    const text = data.getData("text") || data.getData("text/plain");
    const textAttachment = imageAttachmentFromText(text);
    if (textAttachment) {
      preventDefault();
      void addAttachments([textAttachment], gen);
      return;
    }

    // iOS Safari path: the clipboard advertises an image MIME (via
    // data.types or items[].type) but does not expose Files and gives us
    // the bytes only as a text/plain base64 blob whose prefix is NOT one
    // of the four magic strings imageAttachmentFromText keys off of (PNG /
    // JPEG / GIF / WebP). Without this branch the handler falls through,
    // never calls preventDefault, and the default paste action pumps the
    // base64 straight into the textarea — see the bug report screenshot
    // where the user message body is a wall of "AACZ…" base64.
    const advertisedImageMime = clipboardImageMimeType(data);
    if (advertisedImageMime && isBase64Blob(text)) {
      preventDefault();
      const compact = text.replace(/\s/g, "");
      void addAttachments(
        [{
          id: attachmentId(),
          name: "pasted image",
          type: "image",
          mimeType: advertisedImageMime,
          data: compact,
          previewUrl: `data:${advertisedImageMime};base64,${compact}`,
        }],
        gen,
      );
      return;
    }

    if (looksLikeImageData(text) || (hasClipboardImageType(data) && isBase64Blob(text))) {
      preventDefault();
      setPasteWarning(`Clipboard looks like raw image data (${text.length.toLocaleString()} chars), but this browser did not expose it as an image file. Try copying the screenshot again, use the paperclip button, or open Pi Remote Control over HTTPS.`);
      return;
    }

    if (text.length > MAX_PROMPT_CHARS - draft.length) {
      preventDefault();
      setPasteWarning(`Paste blocked: ${text.length.toLocaleString()} chars would exceed the ${MAX_PROMPT_CHARS.toLocaleString()}-char limit.`);
      return;
    }

    if (text && insertTextWhenNotFocused) {
      preventDefault();
      setDraft((current) => current ? `${current}${text}` : text);
      textareaRef.current?.focus({ preventScroll: true });
      return;
    }

    if (!text && hasClipboardImageType(data)) {
      setPasteWarning("The clipboard says it contains an image, but this browser did not expose the image bytes to the page. Try the paperclip button or serve Pi Remote Control over HTTPS.");
    }
  }

  function shouldHandleDocumentPaste(target: EventTarget | null): boolean {
    const active = document.activeElement;
    if (active === textareaRef.current || target === textareaRef.current) return false;
    if (target instanceof Node && composerRef.current?.contains(target)) return true;
    if (active instanceof HTMLElement && isEditablePasteTarget(active)) return false;
    return active === null || active === document.body || active === document.documentElement;
  }

  useEffect(() => {
    function onDocumentPaste(event: ClipboardEvent) {
      if (!event.clipboardData || !shouldHandleDocumentPaste(event.target)) return;
      void handleClipboardPaste(event.clipboardData, () => event.preventDefault(), true);
    }
    document.addEventListener("paste", onDocumentPaste);
    return () => document.removeEventListener("paste", onDocumentPaste);
  });

  const canSubmit = draft.trim().length > 0 || attachments.length > 0;

  const placeholder = mode === "bash"
    ? "Run a shell command (! prefix)"
    : mode === "hidden-bash"
      ? "Hidden shell command (!! prefix)"
      : "Type / for commands";

  return (
    <section ref={composerRef} className={`prompt-composer ${mode}`} aria-label="Prompt composer">
      <div className="composer-input">
        <button
          type="button"
          className="composer-attach"
          aria-label="Add attachment"
          // Skip the paperclip in the natural tab cycle so Shift+Tab from
          // the prompt textarea lands on the previous focusable element
          // (the inline 'name this session' input above the composer)
          // directly, instead of bouncing through the paperclip first.
          // The button is still mouse-clickable and reachable via
          // keyboard shortcut paste / drag-drop.
          tabIndex={-1}
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
            if (event.key === "Tab" && !event.shiftKey) {
              // Forward Tab = @-path completion. Shift+Tab falls through
              // to native back-tab so the user can jump to the inline
              // 'name this session' input above the composer.
              event.preventDefault();
              pathComplete();
              return;
            }
            if (event.key === "ArrowUp" && event.altKey && history[0]) {
              event.preventDefault();
              setDraft(history[0]);
            }
          }}
          onPaste={(event) => void handlePaste(event)}
          onDrop={(event) => {
            event.preventDefault();
            void addFiles(event.dataTransfer.files);
          }}
          onDragOver={(event) => event.preventDefault()}
        />
        {props.isStreaming && !draft.trim() && attachments.length === 0 ? (
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
            disabled={!canSubmit}
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
          {props.statusCwd ? (
            <span className="status-segment status-segment-cwd">
              <span className="sep">·</span>
              <span className="chip" title={props.statusCwd}>{shortPath(props.statusCwd, 32)}</span>
            </span>
          ) : null}
          <span className="status-segment status-segment-model">
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
          </span>
          <span className="sep">·</span>
          <span className="chip composer-status-tokens">
            {(props.statusTokens ?? "0 tokens").split(" ").map((part, index) => {
              const tokClass = part.startsWith("↑")
                ? "tok tok-input"
                : part.startsWith("↓")
                ? "tok tok-output"
                : "tok";
              return <span key={index} className={tokClass}>{part}</span>;
            })}
          </span>
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
  if (typeof file.arrayBuffer === "function") {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    } catch {
      // Some browser/clipboard combinations expose a File object but reject arrayBuffer().
      // Try FileReader before surfacing a paste failure to the user.
    }
  }
  return fileToBase64WithReader(file);
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

function SendGlyph() { return <Icon name="send" />; }
function StopGlyph() { return <Icon name="stop" />; }
function PaperclipGlyph() { return <Icon name="paperclip" />; }

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
