/**
 * Realtime transport selection + SSE-fallback wiring for streamEvents.
 *
 * `streamEvents(sessionId, onEvent) => unsubscribe` is the single seam the
 * dashboard uses. This module picks the transport (feature flag, default SSE
 * during rollout) and, for the Socket.IO path, falls back to SSE after repeated
 * connect failures — sticky per tab so we don't flap.
 *
 * NOTE: intentionally unimplemented (TDD). See
 * tests/unit/realtime-transport-selection.test.ts.
 */
import type { RealtimeConnection } from "./realtime-connection.js";

export type StreamEvents = (sessionId: string, onEvent: (event: unknown) => void) => () => void;

export type RealtimeTransportKind = "sse" | "socketio";

/**
 * Pick the transport from the environment. Default is "sse" so production keeps
 * the proven path until Socket.IO is explicitly enabled with
 * VITE_PI_CRUST_REALTIME=socketio.
 */
export function selectRealtimeTransport(env: Record<string, string | undefined>): RealtimeTransportKind {
  const raw = (env.VITE_PI_CRUST_REALTIME ?? "").trim().toLowerCase();
  return raw === "socketio" ? "socketio" : "sse";
}

export interface CreateStreamEventsOptions {
  readonly transport: RealtimeTransportKind;
  /** Existing EventSource-based streamer (the fallback / default). */
  readonly sse: StreamEvents;
  /** Lazily-built multiplexed connection for the Socket.IO path. */
  readonly socketio?: () => RealtimeConnection;
  readonly onClientEvent?: (event: { kind: string; [key: string]: unknown }) => void;
}

/**
 * Build the streamEvents implementation for the selected transport. When
 * "socketio" is chosen, the returned function subscribes via the multiplexed
 * connection but transparently switches that tab to SSE if the connection
 * signals fallback (sticky for the tab's lifetime).
 */
export function createStreamEvents(options: CreateStreamEventsOptions): StreamEvents {
  if (options.transport === "sse" || !options.socketio) return options.sse;

  // Socket.IO path with sticky SSE fallback. One multiplexed connection is
  // shared across all sessions on this tab. If it ever signals fallback, every
  // current AND future subscription on this tab switches to SSE.
  let connection: RealtimeConnection | null = null;
  let fellBack = false;
  interface ActiveSub { sessionId: string; onEvent: (event: unknown) => void; off: () => void; sse?: () => void; }
  const active = new Set<ActiveSub>();

  const switchAllToSse = (reason: string) => {
    if (fellBack) return;
    fellBack = true;
    options.onClientEvent?.({ kind: "realtime-fallback-active", reason });
    for (const sub of active) {
      try { sub.off(); } catch { /* ignore */ }
      sub.sse = options.sse(sub.sessionId, sub.onEvent);
    }
    connection?.dispose();
    connection = null;
  };

  const ensureConnection = (): RealtimeConnection => {
    if (!connection) {
      connection = options.socketio!();
      connection.onFallback(switchAllToSse);
    }
    return connection;
  };

  return (sessionId, onEvent) => {
    if (fellBack) {
      const off = options.sse(sessionId, onEvent);
      return () => off();
    }
    const conn = ensureConnection();
    const sub: ActiveSub = { sessionId, onEvent, off: () => {} };
    // Per-session fallback: if the gateway can't serve THIS session (e.g. a
    // cold/unknown session reject), the connection emits stream_unavailable.
    // Re-route just this session to SSE; the socket stays up for the others.
    const wrapped = (event: unknown) => {
      if (event && (event as { type?: string }).type === "stream_unavailable") {
        if (!sub.sse) {
          try { sub.off(); } catch { /* ignore */ }
          sub.sse = options.sse(sessionId, onEvent);
        }
        return;
      }
      onEvent(event);
    };
    sub.off = conn.subscribe(sessionId, wrapped);
    active.add(sub);
    return () => {
      active.delete(sub);
      try { sub.off(); } catch { /* ignore */ }
      sub.sse?.();
    };
  };
}
