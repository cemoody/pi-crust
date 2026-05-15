/**
 * Suppress Vite's reload-on-disconnect behavior.
 *
 * Vite's HMR client calls `location.reload()` whenever it can't refresh a
 * module via in-place HMR — most commonly when its WebSocket disconnects.
 * On desktop this is mildly annoying; on iOS Safari it's catastrophic
 * because Safari suspends the WS the moment a tab goes background, and
 * resuming the tab triggers a full reload that destroys scroll position
 * and any composer draft. Telemetry showed every observed "random refresh"
 * on the WUI was this exact code path.
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

let lastVisibleAt = Date.now();
const SUPPRESS_WINDOW_AFTER_RESUME_MS = 5_000;

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") lastVisibleAt = Date.now();
  });
}

if (typeof import.meta !== "undefined" && import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", (event: unknown) => {
    // The event object exposes preventDefault in modern Vite versions.
    const cancel = () => {
      try { (event as { preventDefault?: () => void }).preventDefault?.(); } catch { /* ignore */ }
    };
    if (typeof document === "undefined") return; // SSR / tests — let it pass.

    // 1. Tab is hidden right now: never reload. Wait until visible.
    if (document.visibilityState === "hidden") {
      cancel();
      return;
    }
    // 2. Tab just came back from hidden: HMR is mid-reconnect. The
    //    in-place module patches will arrive within a few hundred ms;
    //    a hasty reload here would wipe scroll/composer state for no
    //    real benefit. Suppress.
    if (Date.now() - lastVisibleAt < SUPPRESS_WINDOW_AFTER_RESUME_MS) {
      cancel();
      return;
    }
    // 3. Foreground and stable for a few seconds: this is a real
    //    "I edited a non-hot-reloadable file" reload. Let it happen
    //    so the user picks up the change.
  });
}
