import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../shared/util.js";
import { Icon } from "./Icon.js";

/**
 * Inline 'name this session' input that lives above the prompt composer
 * while the active session still has zero messages. Owns its own local
 * state so keystrokes don't bubble up to SessionDashboard re-renders
 * (and therefore don't churn the MessageTimeline). Commits on blur.
 */
export function InlineNameInput(props: {
  readonly sessionId: string;
  readonly currentName: string;
  readonly onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState("");
  // Reset draft when switching sessions — we don't want a half-typed
  // name to leak from one fresh session to another.
  useEffect(() => { setDraft(""); }, [props.sessionId]);
  const inputId = `session-name-${props.sessionId}`;
  return (
    <div className="session-name-row">
      {/* Clicking anywhere in the row (including the icon) focuses the
          input — the icon is decorative; the <label htmlFor> handles the
          actual focus delegation. */}
      <label htmlFor={inputId} className="session-name-icon" aria-hidden="true">
        <Icon name="pencil" />
      </label>
      <input
        id={inputId}
        type="text"
        className="session-name-input"
        placeholder={props.currentName || "Optionally name this session…"}
        aria-label="Name this session"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (!next || next === props.currentName) return;
          props.onCommit(next);
        }}
      />
    </div>
  );
}

export function RenameSessionForm(props: {
  readonly initialName: string;
  readonly onSave: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.initialName);

  return (
    <div className="inline-rename" role="group" aria-label="Rename session">
      <input
        autoFocus
        aria-label="Session name"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onSave(draft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
      <button type="button" className="primary" onClick={() => props.onSave(draft)}>Save</button>
      <button type="button" onClick={props.onCancel}>Cancel</button>
    </div>
  );
}

export interface NewSessionInput {
  readonly cwd: string;
  readonly sessionName?: string;
}

export function NewSessionDialog(props: {
  readonly initialCwd: string;
  readonly onCreate: (input: NewSessionInput) => Promise<void> | void;
  readonly onCancel: () => void;
}) {
  const [cwd, setCwd] = useState(props.initialCwd);
  const [sessionName, setSessionName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const cwdRef = useRef<HTMLInputElement | null>(null);

  // Position the caret at the start of the CWD field exactly ONCE on mount,
  // so the path's leading characters are visible on narrow phones. The
  // previous implementation did this in an inline `ref` callback that React
  // re-invokes on every render — which meant every keystroke (and every SSE
  // event that re-rendered the dashboard) jumped the caret back to column 0.
  useEffect(() => {
    const node = cwdRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(0, 0);
    node.scrollLeft = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const name = sessionName.trim();
      await props.onCreate({ cwd: cwd.trim(), ...(name ? { sessionName: name } : {}) });
      // On success the parent unmounts the dialog. If it doesn't (e.g.
      // because onCreate is sync), drop the spinner so the form is usable.
      setSubmitting(false);
    } catch (caught) {
      setSubmitting(false);
      setSubmitError(errorMessage(caught));
    }
  }

  function handleCancel() {
    if (submitting) return; // don't let users back out mid-creation
    props.onCancel();
  }

  return (
    <div className="new-session-backdrop" role="presentation" onClick={handleCancel}>
      <form
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create new session"
        aria-busy={submitting}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <div className="new-session-title">
            <h2>New session</h2>
            <p>Spawn a fresh pi agent in a working directory.</p>
          </div>
          <button type="button" onClick={handleCancel} aria-label="Close new session dialog" disabled={submitting}>×</button>
        </header>
        <div className="new-session-fields">
          <label>
            <span className="field-label">Working directory</span>
            <input
              ref={cwdRef}
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              aria-label="New session cwd"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              disabled={submitting}
            />
            <span className="field-hint">Defaults to your home directory.</span>
          </label>
          <label>
            <span className="field-label">
              Name
              <span className="field-tag">optional</span>
            </span>
            <input
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              aria-label="New session name"
              placeholder="Untitled session"
              spellCheck={false}
              disabled={submitting}
            />
          </label>
          {submitError ? <p className="new-session-error" role="alert">{submitError}</p> : null}
        </div>
        <footer>
          <button type="button" onClick={handleCancel} disabled={submitting}>Cancel</button>
          <button type="submit" className="primary" disabled={submitting || !cwd.trim()} aria-label={submitting ? "Creating session" : "Create session"}>
            {submitting ? (
              <>
                <span className="button-spinner" aria-hidden="true" />
                <span>Creating…</span>
              </>
            ) : "Create session"}
          </button>
        </footer>
      </form>
    </div>
  );
}
