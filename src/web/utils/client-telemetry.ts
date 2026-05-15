/**
 * Client-side telemetry to investigate spurious page refreshes.
 *
 * Posts small JSON payloads to POST /api/client-event. The server appends
 * them to a logs/client-events.jsonl file with timestamps and UA so we can
 * correlate boots and visibility transitions with SSE lifecycle events.
 *
 * Key signals it captures:
 *   - boot:            page just loaded; includes navigationType
 *                      ("navigate" / "reload" / "back_forward" / "prerender"),
 *                      a per-tab bootCount in localStorage, and the
 *                      activeSessionId from the URL.
 *   - visibilitychange: hidden / visible transitions.
 *   - pagehide:        with `persisted` (the bfcache hint).
 *   - pageshow:        with `persisted`.
 *   - beforeunload:    final beacon before the document goes away.
 *   - sse-open / sse-error / sse-close: from the EventSource wiring.
 *
 * Everything is best-effort: a failure to log must never block the app.
 */

const ENDPOINT = "/api/client-event";
const BOOT_COUNT_KEY = "pi-rc:bootCount";
const SESSION_ID_KEY = "pi-rc:tabSessionId";

export interface ClientEventPayload {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface PageLoadContext {
  readonly navigationType: "navigate" | "reload" | "back_forward" | "prerender" | "unknown";
  readonly bootCount: number;
  readonly tabSessionId: string;
  readonly referrer: string;
  readonly url: string;
  readonly visibilityState: DocumentVisibilityState | "unknown";
}

/**
 * Pure helper: derives a page-load context from a (mockable) document /
 * performance / storage trio. Exported separately so tests can run it in
 * Node without a real DOM.
 */
export function derivePageLoadContext(deps: {
  readonly performance: Pick<Performance, "getEntriesByType">;
  readonly document: Pick<Document, "referrer"> & { readonly visibilityState?: DocumentVisibilityState };
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly url: string;
  readonly newUUID: () => string;
}): PageLoadContext {
  const navEntries = (deps.performance.getEntriesByType("navigation") ?? []) as PerformanceNavigationTiming[];
  const rawType = navEntries[0]?.type;
  const navigationType: PageLoadContext["navigationType"] = rawType === "navigate" || rawType === "reload" || rawType === "back_forward" || rawType === "prerender"
    ? rawType
    : "unknown";

  const prior = Number(deps.storage.getItem(BOOT_COUNT_KEY) ?? "0");
  const bootCount = (Number.isFinite(prior) ? prior : 0) + 1;
  deps.storage.setItem(BOOT_COUNT_KEY, String(bootCount));

  let tabSessionId = deps.storage.getItem(SESSION_ID_KEY) ?? "";
  if (!tabSessionId) {
    tabSessionId = deps.newUUID();
    deps.storage.setItem(SESSION_ID_KEY, tabSessionId);
  }

  return {
    navigationType,
    bootCount,
    tabSessionId,
    referrer: deps.document.referrer,
    url: deps.url,
    visibilityState: deps.document.visibilityState ?? "unknown",
  };
}

/**
 * Send a single telemetry event to the API. Uses navigator.sendBeacon when
 * the page is about to be unloaded so the request survives the document
 * teardown; otherwise uses fetch with keepalive.
 */
export function recordClientEvent(payload: ClientEventPayload, options: { readonly leaving?: boolean } = {}): void {
  try {
    const body = JSON.stringify({
      clientTs: Date.now(),
      ...payload,
    });

    if (options.leaving && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(ENDPOINT, blob);
      return;
    }

    if (typeof fetch === "function") {
      // keepalive lets the request continue even if the document is being
      // torn down (Chrome / Edge / Safari all honor it for small bodies).
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => undefined);
    }
  } catch {
    // Telemetry must never throw into the app.
  }
}

/**
 * Wire up the lifecycle listeners. Safe to call exactly once at app boot.
 */
export function installClientTelemetry(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const flag = "__piRcTelemetryInstalled" as const;
  type FlaggedWindow = Window & { [flag]?: boolean };
  const w = window as FlaggedWindow;
  if (w[flag]) return;
  w[flag] = true;

  // Per-tab id, NOT shared across tabs. sessionStorage is scoped to the
  // browsing context (the tab / popup), so two tabs in the same browser get
  // distinct ids — which is exactly what server-side SSE eviction needs to
  // avoid one tab kicking another off its event stream.
  const context = derivePageLoadContext({
    performance: window.performance,
    document,
    storage: window.sessionStorage,
    url: window.location.href,
    newUUID: () => crypto?.randomUUID?.() ?? `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  });

  recordClientEvent({
    kind: "boot",
    ...context,
    activeSessionId: new URL(window.location.href).searchParams.get("session"),
    userAgent: navigator.userAgent,
    timeOrigin: window.performance.timeOrigin,
  });

  document.addEventListener("visibilitychange", () => {
    recordClientEvent({
      kind: "visibilitychange",
      visibilityState: document.visibilityState,
      tabSessionId: context.tabSessionId,
    });
  });

  window.addEventListener("pagehide", (event) => {
    recordClientEvent({
      kind: "pagehide",
      persisted: (event as PageTransitionEvent).persisted,
      tabSessionId: context.tabSessionId,
    }, { leaving: true });
  });

  window.addEventListener("pageshow", (event) => {
    recordClientEvent({
      kind: "pageshow",
      persisted: (event as PageTransitionEvent).persisted,
      tabSessionId: context.tabSessionId,
    });
  });

  window.addEventListener("beforeunload", () => {
    recordClientEvent({
      kind: "beforeunload",
      tabSessionId: context.tabSessionId,
    }, { leaving: true });
  });

  window.addEventListener("error", (event) => {
    recordClientEvent({
      kind: "window-error",
      message: String((event as ErrorEvent).message ?? ""),
      filename: String((event as ErrorEvent).filename ?? ""),
      lineno: Number((event as ErrorEvent).lineno ?? 0),
      tabSessionId: context.tabSessionId,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    recordClientEvent({
      kind: "unhandledrejection",
      reason: String((event as PromiseRejectionEvent).reason ?? ""),
      tabSessionId: context.tabSessionId,
    });
  });
}

/** Exposed so other modules (e.g. the EventSource wrapper) can read the tab id.
 *  Reads from sessionStorage so each tab has its own id. */
export function getTabSessionId(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(SESSION_ID_KEY) ?? "";
}
