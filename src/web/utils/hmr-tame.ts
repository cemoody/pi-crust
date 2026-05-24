/**
 * Suppress Vite's reload-on-disconnect behavior.
 *
 * Vite's HMR client calls `location.reload()` whenever it can't refresh a
 * module via in-place HMR — most commonly when its WebSocket disconnects.
 * On desktop this is mildly annoying; on iOS Safari it's catastrophic
 * because Safari suspends the WS the moment a tab goes background, and
 * resuming the tab triggers a full reload that destroys scroll position
 * and any composer draft. Telemetry showed every observed "random refresh"
 * on the pi-crust was this exact code path.
 *
 * Fix: intercept Vite's `vite:beforeFullReload` event and cancel it when
 * the reload would be due to a transient disconnect (tab in the background
 * or having just resumed). On true config-level changes while the tab is
 * actively in the foreground we still allow the reload, because that's the
 * only way to pick up some non-hot-reloadable edits.
 *
 * Reference: https://vite.dev/guide/api-hmr.html — `vite:beforeFullReload`
 * is a documented event that supports `event.preventDefault()`.
 */

export const SUPPRESS_WINDOW_AFTER_RESUME_MS = 5_000;

export interface ReloadDecisionDeps {
  readonly visibilityState: () => "visible" | "hidden" | "prerender" | "unloaded" | string;
  readonly now: () => number;
}

/**
 * Pure decision logic, extracted for testability. Given the time the tab
 * was last visible and the current state, returns `true` if Vite's
 * full-reload should be cancelled.
 */
export function shouldSuppressReload(deps: ReloadDecisionDeps, lastVisibleAt: number): boolean {
  // 1. Tab is hidden right now: never reload while invisible.
  if (deps.visibilityState() === "hidden") return true;
  // 2. Tab just came back from hidden: HMR is mid-reconnect. Suppress
  //    while the reconnect catches up — in-place patches will arrive
  //    within a few hundred ms.
  if (deps.now() - lastVisibleAt < SUPPRESS_WINDOW_AFTER_RESUME_MS) return true;
  // 3. Foreground-stable: real "non-hot-reloadable file changed" reload.
  return false;
}

/**
 * Install the listeners. Exported for tests to drive directly; in the pi-crust,
 * we call it once at the top of main.tsx with the live document and the
 * live import.meta.hot.
 */
export interface InstallDeps {
  /**
   * Loosely typed so tests can pass a minimal stub. In production this is
   * the real document object.
   */
  readonly document: {
    readonly visibilityState: string;
    addEventListener(name: string, cb: () => void): void;
  };
  readonly hot: { on(event: string, cb: (event: { preventDefault?: () => void }) => void): void } | undefined;
  readonly now: () => number;
}

export function installHmrTame(deps: InstallDeps): void {
  let lastVisibleAt = deps.now();
  deps.document.addEventListener("visibilitychange", () => {
    if (deps.document.visibilityState === "visible") lastVisibleAt = deps.now();
  });
  if (!deps.hot) return;
  deps.hot.on("vite:beforeFullReload", (event) => {
    const decisionDeps: ReloadDecisionDeps = {
      visibilityState: () => deps.document.visibilityState,
      now: deps.now,
    };
    if (shouldSuppressReload(decisionDeps, lastVisibleAt)) {
      try { event.preventDefault?.(); } catch { /* ignore */ }
    }
  });
}

// --- Auto-install when imported in a browser context. ---
//
// We deliberately do this at module evaluation time so the listener is in
// place before the first HMR event can fire (see comment at the top of
// main.tsx about import ordering).
if (typeof document !== "undefined") {
  installHmrTame({
    document: document as unknown as InstallDeps["document"],
    hot: (import.meta as unknown as { hot?: InstallDeps["hot"] }).hot,
    now: () => Date.now(),
  });
}
