import { getTabSessionId, recordClientEvent } from "../utils/client-telemetry.js";

export const SSE_SILENCE_THRESHOLD_MS = 30_000;
export const SSE_SILENCE_CHECK_INTERVAL_MS = 15_000;

export interface SseSessionStreamOptions {
  readonly apiBase: string;
  readonly sessionId: string;
  readonly onEvent: (event: unknown) => void;
}

/** Owns the EventSource fallback lifecycle for one dashboard session. */
export function createSseSessionStream({ apiBase, sessionId, onEvent }: SseSessionStreamOptions): () => void {
  const openedAt = Date.now();
  // Pass the per-tab id so the server can evict an older SSE for the same
  // tab when this tab re-opens one (e.g. on rapid session-switching). Without
  // this, leaked streams accumulate against Chrome's 6-per-origin HTTP/1.1
  // connection budget and new requests stall. See tests/playwright/
  // sse-connection-pool.spec.ts for the repro.
  const tab = getTabSessionId();
  const qs = tab ? `?tabSessionId=${encodeURIComponent(tab)}` : "";
  const url = `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/events${qs}`;

  let source: EventSource | null = null;
  let lastMessageAt = Date.now();
  let silenceWarnedAt = 0;
  let stopped = false;
  // Highest server seq we've already delivered. The server tags every event
  // with `id: <seq>`, so the browser's NATIVE EventSource auto-reconnect
  // (which silently resumes via Last-Event-ID) replays buffered events we
  // have already seen. Without this guard those replays are re-delivered to
  // the reducer and produce duplicate messages that only disappear on a full
  // reload. The Socket.IO path dedupes identically (see
  // realtime-connection.ts); this brings the SSE fallback to parity.
  // Reset in openSource() because a MANUAL reconnect opens a fresh stream
  // from `null` (live-only, no replay) where the seq counter is authoritative.
  let lastDeliveredSeq = -1;

  const wireHandlers = (currentSource: EventSource) => {
    currentSource.onmessage = (event) => {
      lastMessageAt = Date.now();
      // Drop already-delivered seqs from a transparent auto-reconnect replay.
      // `lastEventId` is the `id:` of the most recent SSE frame; legacy/test
      // streams without ids leave it empty, so we fall through and deliver.
      const seq = Number(event.lastEventId);
      if (Number.isFinite(seq)) {
        if (seq <= lastDeliveredSeq) return;
        lastDeliveredSeq = seq;
      }
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        // ignore malformed payloads
      }
    };
    currentSource.onopen = () => {
      lastMessageAt = Date.now();
      recordClientEvent({
        kind: "sse-client-open",
        sessionId,
        tabSessionId: getTabSessionId(),
      });
    };
    currentSource.onerror = () => {
      recordClientEvent({
        kind: "sse-client-error",
        sessionId,
        readyState: currentSource.readyState,
        ageMs: Date.now() - openedAt,
        tabSessionId: getTabSessionId(),
      });
    };
  };

  const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

  const openSource = () => {
    // A manual (re)open requests no Last-Event-ID, so the server streams only
    // live events from its current counter. Reset our high-water mark so we
    // don't wrongly drop fresh seqs (e.g. after a worker restart reset them).
    lastDeliveredSeq = -1;
    source = new EventSource(url);
    wireHandlers(source);
    lastMessageAt = Date.now();
  };
  if (isVisible()) openSource();

  const closeSource = (reason: string) => {
    const currentSource = source;
    if (!currentSource) return;
    source = null;
    try { currentSource.close(); } catch { /* ignore */ }
    recordClientEvent({
      kind: "sse-client-pause",
      sessionId,
      reason,
      ageMs: Date.now() - openedAt,
      tabSessionId: getTabSessionId(),
    });
  };

  // Re-establish a stream that the browser tore down. Mobile browsers
  // (iOS Safari / Android Chrome) suspend networking when a tab is
  // backgrounded; after ~minutes the EventSource ends up either CLOSED
  // with no `onerror` delivered, or stuck in OPEN with a dead socket.
  // Without this, returning to the tab after ~20 minutes leaves the UI
  // permanently silent until the user reloads. See the
  // "mobile background reconnect" suite in
  // tests/unit/http-session-api-telemetry.test.ts.
  const reconnect = (reason: string) => {
    if (stopped) return;
    closeSource(reason);
    recordClientEvent({
      kind: "sse-client-reconnect",
      sessionId,
      reason,
      ageMs: Date.now() - openedAt,
      tabSessionId: getTabSessionId(),
    });
    openSource();
    // Notify the host so it can refetch /messages and pick up everything
    // that happened on the server while the tab was suspended. Without
    // this the SSE resumes mid-flight and the transcript stays stuck on
    // the last pre-suspend frame (e.g. shows "idle" with no streaming).
    try {
      onEvent({ type: "stream_reconnected", reason });
    } catch { /* host listener must never break the stream */ }
  };

  // Silence detector. The 2026-05-24 outage was a session whose SSE was
  // OPEN (no error fired) but received zero events because the API's
  // in-memory session handle had silently closed. EventSource never fires
  // 'error' for that — the TCP connection is healthy, the data just
  // doesn't flow. Emit a structured client-side warning so we can detect
  // the symptom even when the browser API gives us no signal, then self-
  // heal by reconnecting.
  const silenceTimer = setInterval(() => {
    // Only count silence while the tab is visible; a backgrounded tab
    // intentionally has no SSE connection, so it should not log silence or
    // reopen a stream that would consume the browser's per-origin pool.
    if (!isVisible()) return;
    if (!source || source.readyState !== EventSource.OPEN) {
      // Visible tab + no open stream means either we intentionally paused it
      // while hidden, or the browser killed it. Recover proactively (covers
      // the case where visibilitychange did not fire on resume, or fired
      // before readyState updated).
      reconnect("silence-tick-not-open");
      return;
    }
    const idleMs = Date.now() - lastMessageAt;
    if (idleMs >= SSE_SILENCE_THRESHOLD_MS && Date.now() - silenceWarnedAt >= SSE_SILENCE_THRESHOLD_MS) {
      silenceWarnedAt = Date.now();
      recordClientEvent({
        kind: "sse-silence",
        sessionId,
        idleMs,
        ageMs: Date.now() - openedAt,
        tabSessionId: getTabSessionId(),
      });
      reconnect("sse-silence");
    }
  }, SSE_SILENCE_CHECK_INTERVAL_MS);

  const maybeReconnectOnResume = (reason: string) => {
    if (!isVisible()) return;
    // Mobile suspend signature: the browser closed the underlying socket
    // while we were hidden — or we intentionally paused it on hide to free
    // Chrome's six HTTP/1.1 connections for active tabs' normal API calls.
    // Reconnect immediately so the user sees streaming resume the instant
    // they return to the tab.
    if (!source || source.readyState !== EventSource.OPEN) {
      reconnect(`${reason}-stream-closed`);
      return;
    }
    // "Zombie socket" signature: readyState lies and says OPEN, but no
    // bytes have flowed for the suspend window. If we were hidden long
    // enough that any server-pushed event must have been missed, force
    // a refresh.
    const idleMs = Date.now() - lastMessageAt;
    if (idleMs >= SSE_SILENCE_THRESHOLD_MS) {
      reconnect(`${reason}-stream-stale`);
    }
  };
  const onVisibilityChange = () => {
    if (!isVisible()) {
      closeSource("visibility-hidden");
      return;
    }
    maybeReconnectOnResume("visibility-restored");
  };
  // iOS Safari restores tabs from the back-forward cache without firing
  // visibilitychange and without resuming JS timers. The reliable signal
  // is `pageshow` with event.persisted=true. We also accept a non-
  // persisted pageshow / window focus / online as cheap belt-and-braces
  // for browsers that vary; all of these defer to maybeReconnectOnResume
  // which is idempotent and only acts when the socket actually looks dead.
  const onPageShow = (event?: unknown) => {
    const persisted = !!(event && typeof event === "object" && (event as { persisted?: boolean }).persisted);
    maybeReconnectOnResume(persisted ? "pageshow-bfcache" : "pageshow");
  };
  const onWindowFocus = () => maybeReconnectOnResume("window-focus");
  const onOnline = () => maybeReconnectOnResume("network-online");
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("online", onOnline);
  }

  return () => {
    stopped = true;
    clearInterval(silenceTimer);
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("online", onOnline);
    }
    closeSource("unsubscribe");
    recordClientEvent({
      kind: "sse-client-close",
      sessionId,
      ageMs: Date.now() - openedAt,
      tabSessionId: getTabSessionId(),
    });
  };
}
