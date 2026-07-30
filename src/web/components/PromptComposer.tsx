import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { uniqueValues } from "../../shared/util.js";
import "./prompt-composer.css";
import { Icon } from "./Icon.js";
import { useOptionalNotifications } from "./notifications.js";
import { isEditablePasteTarget } from "./prompt-composer-clipboard.js";
import { useComposerAttachments } from "./prompt-composer-attachments.js";
export type { ComposerAttachment } from "./prompt-composer-attachments.js";
import type { ComposerAttachment } from "./prompt-composer-attachments.js";

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
  readonly onSlashCommand?: (name: string, argv: string, original: string) => void | Promise<void>;
  readonly draftSeed?: { readonly id: string; readonly value: string };
  readonly statusText?: string;
  readonly connectionStatusText?: string;
  readonly statusCwd?: string;
  readonly statusModel?: string;
  readonly statusTokens?: string;
}

const DRAFT_PERSIST_DELAY_MS = 300;

export function PromptComposer(props: PromptComposerProps) {
  const storageKey = `draft:${props.sessionId}`;
  const [draft, setDraft] = useState(() => storageGet(storageKey) ?? "");
  const draftRef = useRef(draft);
  const storageKeyRef = useRef(storageKey);
  const draftPersistenceRef = useRef({
    key: storageKey,
    value: draft,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    // The initial value was just read from storage, so mounting must not turn
    // it into a redundant synchronous write.
    lastPersisted: new Map([[storageKey, draft]]),
  });
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const lastDraftLengthRef = useRef(draft.length);
  const lastTextareaHeightRef = useRef<string | undefined>(undefined);
  const [history, setHistory] = useState<string[]>([]);
  // Paste warnings are surfaced through the global toast system when
  // available, falling back to inline state if the composer is rendered
  // outside a NotificationsProvider (e.g. unit tests).
  const notifications = useOptionalNotifications();
  const [pasteWarningLocal, setPasteWarningLocal] = useState<string | null>(null);
  const pasteWarningIdRef = useRef<string | null>(null);
  const setPasteWarning = (message: string | null) => {
    if (notifications) {
      if (pasteWarningIdRef.current) {
        notifications.dismiss(pasteWarningIdRef.current);
        pasteWarningIdRef.current = null;
      }
      if (message) {
        pasteWarningIdRef.current = notifications.notify({ kind: "warning", message });
      }
      return;
    }
    setPasteWarningLocal(message);
  };
  const pasteWarning = notifications ? null : pasteWarningLocal;

  useEffect(() => {
    // Auto-dismiss only matters for the fallback inline render — the toast
    // system has its own auto-dismiss for warning notifications.
    if (!pasteWarningLocal) return;
    const t = setTimeout(() => setPasteWarningLocal(null), 6_000);
    return () => clearTimeout(t);
  }, [pasteWarningLocal]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const { attachments, attachmentsRef, clearAttachments, removeAttachment, addFiles, handleClipboardPaste } = useComposerAttachments({
    draftLength: draft.length,
    textareaRef,
    updateDraft,
    setPasteWarning,
  });

  function flushDraftPersistence() {
    const pending = draftPersistenceRef.current;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    if (pending.lastPersisted.get(pending.key) === pending.value) return;
    storageSet(pending.key, pending.value);
    pending.lastPersisted.set(pending.key, pending.value);
  }

  function scheduleDraftPersistence(key: string, value: string, flush = false) {
    const pending = draftPersistenceRef.current;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.key = key;
    pending.value = value;
    if (flush) {
      flushDraftPersistence();
    } else {
      pending.timer = setTimeout(flushDraftPersistence, DRAFT_PERSIST_DELAY_MS);
    }
  }

  function updateDraft(next: string | ((current: string) => string), flush = false) {
    const value = typeof next === "function" ? next(draftRef.current) : next;
    draftRef.current = value;
    setDraft(value);
    scheduleDraftPersistence(storageKeyRef.current, value, flush);
  }

  useEffect(() => {
    // A session switch must not strand a just-typed draft in the debounce
    // window. Flush it under the old key before loading the next session.
    flushDraftPersistence();
    storageKeyRef.current = storageKey;
    const restored = storageGet(storageKey) ?? "";
    draftRef.current = restored;
    draftPersistenceRef.current.key = storageKey;
    draftPersistenceRef.current.value = restored;
    draftPersistenceRef.current.lastPersisted.set(storageKey, restored);
    setDraft(restored);
    // Attachments are not session-scoped, so changing sessions must drop
    // the previous session's pending attachments. Otherwise the user
    // reports the image "stays attached" after navigating to another
    // session and has to click Remove manually.
    clearAttachments();
  }, [storageKey]);

  useEffect(() => () => flushDraftPersistence(), []);

  useEffect(() => {
    if (!props.draftSeed) return;
    updateDraft(props.draftSeed.value);
    textareaRef.current?.focus({ preventScroll: true });
  }, [props.draftSeed]);

  useEffect(() => {
    const requestFrame = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
    const cancelFrame = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
    if (resizeFrameRef.current !== undefined) cancelFrame(resizeFrameRef.current);
    resizeFrameRef.current = requestFrame(() => {
      resizeFrameRef.current = undefined;
      const el = textareaRef.current;
      if (!el) return;
      // A fixed inline height can make browsers report that old height as
      // scrollHeight after the draft is shortened. Reset before measuring in
      // that case so a sent or deleted long prompt returns to its natural
      // size, while ordinary typing avoids needless style invalidations.
      const mayNeedToShrink = draft.length < lastDraftLengthRef.current;
      if (mayNeedToShrink) el.style.height = "auto";
      const height = `${el.scrollHeight}px`;
      lastDraftLengthRef.current = draft.length;
      if (!mayNeedToShrink && (height === lastTextareaHeightRef.current || height === el.style.height)) return;
      el.style.height = height;
      lastTextareaHeightRef.current = height;
    });
    return () => {
      if (resizeFrameRef.current !== undefined) cancelFrame(resizeFrameRef.current);
      resizeFrameRef.current = undefined;
    };
  }, [draft]);

  const mode = draft.startsWith("!!") ? "hidden-bash" : draft.startsWith("!") ? "bash" : "prompt";
  const activeToken = draft.split(/\s/).at(-1) ?? "";
  // Filtering a potentially large project-file/command list is non-urgent
  // visual work; keep typing and controlled textarea updates responsive.
  const deferredDraft = useDeferredValue(draft);
  const deferredActiveToken = deferredDraft.split(/\s/).at(-1) ?? "";
  const fileMatches = useMemo(() => deferredActiveToken.startsWith("@")
    ? props.fileSuggestions.filter((file) => file.toLowerCase().includes(deferredActiveToken.slice(1).toLowerCase()))
    : [], [deferredActiveToken, props.fileSuggestions]);
  const commandMatches = useMemo(() => deferredDraft.startsWith("/")
    ? uniqueValues(props.commandSuggestions).filter((command) => command.toLowerCase().includes(deferredDraft.slice(1).toLowerCase()))
    : [], [deferredDraft, props.commandSuggestions]);

  const queueSummary = useMemo(() => [
    ...props.steeringQueue.map((item) => `Steer: ${item}`),
    ...props.followUpQueue.map((item) => `Follow-up: ${item}`),
  ], [props.followUpQueue, props.steeringQueue]);

  async function submit(kind?: "steer" | "follow-up") {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    if (text) setHistory((current) => [text, ...current]);
    updateDraft("", true);
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
      await props.onSlashCommand(name, argv, text);
      clearAttachments();
      return;
    }
    // Capture the attachments snapshot before clearing them locally so
    // an in-flight onPrompt's await doesn't see them mutate underneath.
    // Use the event-time ref: native clipboard ingestion may have committed
    // after this render's click handler was created.
    const snapshot = attachmentsRef.current;
    clearAttachments();
    if (kind === "steer") await props.onSteer(text);
    else if (kind === "follow-up") await props.onFollowUp(text);
    else if (props.isStreaming) await props.onFollowUp(text);
    else await props.onPrompt(text, snapshot);
  }

  function completeFile(file: string) {
    updateDraft((current) => current.replace(/@\S*$/, `@${file}`));
  }

  function completeCommand(command: string) {
    updateDraft(`/${command}`);
  }

  function pathComplete() {
    if (!activeToken) return;
    const needle = activeToken.replace(/^@/, "").toLowerCase();
    const match = props.fileSuggestions.find((file) => file.toLowerCase().startsWith(needle));
    if (match) {
      updateDraft((current) => current.replace(/\S*$/, `@${match}`));
    }
  }

  function shouldHandleDocumentPaste(target: EventTarget | null): boolean {
    const active = document.activeElement;
    if (active === textareaRef.current || target === textareaRef.current) return false;
    if (target instanceof Node && composerRef.current?.contains(target)) return true;
    if (active instanceof HTMLElement && isEditablePasteTarget(active)) return false;
    return active === null || active === document.body || active === document.documentElement;
  }

  // Keep the document listener stable across draft renders. Its callback
  // intentionally reads refs/current state through the component closure only
  // for event-time behavior; re-registering it per keystroke is needless DOM
  // listener churn and opens tiny remove/add gaps.
  const documentPasteHandlerRef = useRef<(event: ClipboardEvent) => void>(() => {});
  documentPasteHandlerRef.current = (event) => {
    if (!event.clipboardData || !shouldHandleDocumentPaste(event.target)) return;
    void handleClipboardPaste(event.clipboardData, () => event.preventDefault(), true);
  };
  useEffect(() => {
    const onDocumentPaste = (event: ClipboardEvent) => documentPasteHandlerRef.current(event);
    document.addEventListener("paste", onDocumentPaste);
    return () => document.removeEventListener("paste", onDocumentPaste);
  }, []);

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
          onChange={(event) => updateDraft(event.target.value)}
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
              updateDraft(history[0]);
            }
          }}
          onPaste={(event) => void handleClipboardPaste(event.clipboardData, () => event.preventDefault(), false)}
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
              <button type="button" onClick={() => removeAttachment(attachment.id)}>Remove</button>
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
          {props.connectionStatusText ? <span className="chip composer-connection-status">{props.connectionStatusText}</span> : null}
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
                onClick={() => void props.onSlashCommand?.("model", "", "/model")}
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
