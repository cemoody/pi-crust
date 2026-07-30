/**
 * Light/dark theme helper. The active theme is encoded as a
 * `data-theme="light|dark"` attribute on the document element; the CSS in
 * `design-system.css` overrides the design tokens under
 * `:root[data-theme="dark"]` so the whole UI flips.
 *
 * The preference is persisted in localStorage and, on first visit (no stored
 * value), falls back to the OS `prefers-color-scheme` setting. `initTheme()`
 * is meant to run *before* React's first paint so there is no flash of the
 * wrong theme.
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "pi-crust-theme";

/** Hex color written to the PWA `theme-color` meta while a theme is active.
 *  Kept in JS (not read from CSS) because the meta lives in `index.html` and
 *  must be updated imperatively. The light value matches the initial
 *  `<meta name="theme-color">` in `index.html` (and the `--gold-100` token)
 *  so there is no flash of a different chrome color before `initTheme()`
 *  runs; the dark value matches `--background-1` in the dark theme block of
 *  `design-system.css`. */
export const LIGHT_THEME_COLOR = "#FBF6E2";
export const DARK_THEME_COLOR = "#111309";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve the theme that should be active right now: stored pref wins,
 *  otherwise the OS preference, otherwise light. */
export function getPreferredTheme(): Theme {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  }
  return systemPrefersDark() ? "dark" : "light";
}

/** Read the currently-applied theme from the document element. Defaults to
 *  "light" when the attribute is unset (e.g. during SSR or before init). */
export function getActiveTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** Apply a theme to the document and sync the browser chrome (PWA theme-color
 *  meta + iOS status-bar tint) so the bezel matches the app surface. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

/** Persist a theme choice so it survives reloads. */
export function setStoredTheme(theme: Theme): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode, disabled storage); the
    // in-memory attribute still applies for the current session.
  }
}

/** Apply the preferred theme. Call once before first render to avoid FOUC. */
export function initTheme(): void {
  applyTheme(getPreferredTheme());
}
