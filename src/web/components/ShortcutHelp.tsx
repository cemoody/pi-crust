import { useEffect, useState } from "react";
import "./shortcut-help.css";

interface Shortcut {
  readonly keys: string;
  readonly label: string;
}

const SHORTCUTS: readonly Shortcut[] = [
  { keys: "Enter", label: "Send (or steer while streaming)" },
  { keys: "Shift+Enter", label: "Newline" },
  { keys: "Cmd/Ctrl+Enter", label: "Send" },
  { keys: "Alt+Enter", label: "Queue follow-up" },
  { keys: "Esc", label: "Abort while streaming" },
  { keys: "Alt+↑", label: "Recall prompt history" },
  { keys: "Tab", label: "Path completion after @" },
  { keys: "?", label: "Open this dialog" },
];

export interface ShortcutHelpProps {
  /**
   * Source of the backend's git SHA (and any other server-identity info we
   * might want to show later). Default impl hits `/api/health`; tests inject
   * a mock.
   */
  readonly fetchBackendInfo?: () => Promise<{ readonly gitSha?: string }>;
}

function readFrontendGitSha(): string {
  // Vite's `define` rewrites this identifier at build time into a string
  // literal; in tests we let globalThis.__PI_REMOTE_GIT_SHA__ stand in. Read
  // it at render time, not module-load, so tests can mutate the global
  // before the dialog opens.
  type ShaHolder = { readonly __PI_REMOTE_GIT_SHA__?: unknown };
  const fromGlobal = (globalThis as unknown as ShaHolder).__PI_REMOTE_GIT_SHA__;
  if (typeof fromGlobal === "string" && fromGlobal.trim()) return fromGlobal;
  try {
    // The build-time define resolves the bare identifier; access via Function
    // to avoid TypeScript noting the identifier is unused if globalThis path
    // already returned. Falls back if undefined.
    // eslint-disable-next-line no-new-func
    const baked = (new Function("return typeof __PI_REMOTE_GIT_SHA__ === 'string' ? __PI_REMOTE_GIT_SHA__ : undefined"))();
    if (typeof baked === "string" && baked.trim()) return baked;
  } catch {
    // ignore
  }
  return "unknown";
}

async function defaultFetchBackendInfo(): Promise<{ readonly gitSha?: string }> {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error(`/api/health -> ${response.status}`);
  return response.json();
}

export function ShortcutHelp(props: ShortcutHelpProps = {}) {
  const fetchBackendInfo = props.fetchBackendInfo ?? defaultFetchBackendInfo;
  const [open, setOpen] = useState(false);
  const [backendSha, setBackendSha] = useState<string>("…");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "?") return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Lazily fetch the backend SHA the first time the dialog opens. We don't
  // want to hit /api/health on every page load just for help-dialog text.
  useEffect(() => {
    if (!open) return;
    if (backendSha !== "…") return;
    let cancelled = false;
    void fetchBackendInfo()
      .then((info) => {
        if (cancelled) return;
        const sha = typeof info.gitSha === "string" && info.gitSha.trim() ? info.gitSha : "unknown";
        setBackendSha(sha);
      })
      .catch(() => {
        if (!cancelled) setBackendSha("unknown");
      });
    return () => { cancelled = true; };
  }, [open, fetchBackendInfo, backendSha]);

  if (!open) return null;

  return (
    <div
      className="shortcut-help-backdrop"
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="shortcut-help"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>Keyboard shortcuts</h2>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close shortcuts">×</button>
        </header>
        <dl>
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys}>
              <dt><kbd>{shortcut.keys}</kbd></dt>
              <dd>{shortcut.label}</dd>
            </div>
          ))}
        </dl>
        <footer className="shortcut-help-footer" aria-label="Build versions">
          <dl className="shortcut-help-shas">
            <div>
              <dt>frontend</dt>
              <dd><code>{readFrontendGitSha()}</code></dd>
            </div>
            <div>
              <dt>backend</dt>
              <dd><code>{backendSha === "…" ? "fetching…" : backendSha}</code></dd>
            </div>
          </dl>
        </footer>
      </div>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}
