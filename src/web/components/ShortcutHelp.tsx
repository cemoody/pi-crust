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
   * Backend identity already loaded by the parent dashboard. When present we
   * use it synchronously instead of opening another `/api/health` request from
   * the help dialog; that request can sit behind the browser's per-origin SSE
   * connection pool when many pi-crust tabs are open.
   */
  readonly backendInfo?: { readonly gitSha?: string };
  /**
   * Source of the backend's git SHA (and any other server-identity info we
   * might want to show later). Default impl hits `/api/health`; tests inject
   * a mock.
   */
  readonly fetchBackendInfo?: () => Promise<{ readonly gitSha?: string }>;
}

function normalizeGitSha(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFrontendGitSha(): string | null {
  // Vite's `define` rewrites this identifier at build time into a string
  // literal. In production (`vite build`) we want to surface that SHA — it's
  // the actual commit the bundle was compiled from and can legitimately
  // differ from the backend's git HEAD if the two are deployed separately.
  //
  // In DEV (`vite serve`), the define is intentionally omitted so this
  // returns null, and the caller falls back to the backend's live gitSha.
  // Why: the dev bundle is HMR-patched in place from the same checkout that
  // serves the api, so any baked-in SHA is just a startup-time snapshot of
  // the same value the backend reports live — and was the source of
  // 'I merged a PR but the help dialog still shows the old SHA' confusion.
  //
  // Test hook: globalThis.__PI_CRUST_GIT_SHA__ stands in for the bake.
  type ShaHolder = { readonly __PI_CRUST_GIT_SHA__?: unknown };
  const fromGlobal = (globalThis as unknown as ShaHolder).__PI_CRUST_GIT_SHA__;
  if (typeof fromGlobal === "string" && fromGlobal.trim()) return fromGlobal;
  try {
    // eslint-disable-next-line no-new-func
    const baked = (new Function("return typeof __PI_CRUST_GIT_SHA__ === 'string' ? __PI_CRUST_GIT_SHA__ : undefined"))();
    if (typeof baked === "string" && baked.trim()) return baked;
  } catch {
    // ignore
  }
  return null;
}

async function defaultFetchBackendInfo(): Promise<{ readonly gitSha?: string }> {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error(`/api/health -> ${response.status}`);
  return response.json();
}

export function ShortcutHelp(props: ShortcutHelpProps = {}) {
  const fetchBackendInfo = props.fetchBackendInfo ?? defaultFetchBackendInfo;
  const providedBackendSha = normalizeGitSha(props.backendInfo?.gitSha);
  const [open, setOpen] = useState(false);
  const [backendSha, setBackendSha] = useState<string>(() => providedBackendSha ?? "…");

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

  useEffect(() => {
    if (providedBackendSha) setBackendSha(providedBackendSha);
  }, [providedBackendSha]);

  // Lazily fetch the backend SHA the first time the dialog opens, but only if
  // the parent dashboard has not already loaded it. We don't want to hit
  // /api/health on every page load just for help-dialog text, and we also
  // don't want the help modal to start a request that can queue behind six
  // long-lived EventSource connections in the browser pool.
  useEffect(() => {
    if (providedBackendSha) return;
    if (!open) return;
    if (backendSha !== "…") return;
    let cancelled = false;
    void fetchBackendInfo()
      .then((info) => {
        if (cancelled) return;
        setBackendSha(normalizeGitSha(info.gitSha) ?? "unknown");
      })
      .catch(() => {
        if (!cancelled) setBackendSha("unknown");
      });
    return () => { cancelled = true; };
  }, [open, fetchBackendInfo, backendSha, providedBackendSha]);

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
              <dd><code>{(readFrontendGitSha() ?? (backendSha === "…" ? "fetching…" : backendSha))}</code></dd>
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
