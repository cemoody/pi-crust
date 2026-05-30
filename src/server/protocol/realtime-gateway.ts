import type http from "node:http";
import { Server as SocketIoServer } from "socket.io";
import type { PiEvent } from "../pi/types.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { RegisteredSession, SessionRegistry } from "../session/session-registry.js";

/**
 * Resolve a session by the id a client subscribed with, opening it from disk
 * if it is not currently hot. Mirrors the HTTP `getOrOpenSession` path so the
 * realtime transport has exact parity with the legacy SSE route.
 */
export type ResolveSession = (sessionId: string) => Promise<RegisteredSession>;

export interface AttachRealtimeGatewayOptions {
  readonly server: http.Server;
  readonly registry: SessionRegistry;
  readonly resolveSession: ResolveSession;
  /** Optional PTY manager enabling the browser Terminal tab (`pty:*` events).
   *  When omitted, `pty:open` is rejected via ack (terminal disabled). */
  readonly ptyManager?: PtyManager;
  /** Socket.IO mount path. Defaults to the library default `/socket.io/`. */
  readonly path?: string;
}

export interface RealtimeGatewayStats {
  /** Number of currently-open physical Socket.IO connections. */
  readonly connections: number;
}

export interface RealtimeGateway {
  readonly io: SocketIoServer;
  stats(): RealtimeGatewayStats;
  close(): Promise<void>;
}

interface SubscribeRequest {
  readonly sessionId?: unknown;
  readonly fromSeq?: unknown;
}

interface SubscribeAck {
  readonly ok: boolean;
  readonly sessionId?: string;
  readonly lastSeq?: number;
  readonly error?: string;
}

interface SessionEventEnvelope {
  readonly sessionId: string;
  readonly seq: number;
  readonly event: PiEvent;
}

/**
 * Mount a Socket.IO realtime gateway on an existing HTTP server.
 *
 * One physical connection multiplexes many logical session subscriptions
 * (`session:subscribe` / `session:unsubscribe`, both ack'd). Live session
 * events are delivered as `session:event` envelopes carrying the registry seq
 * so the client can resume after a reconnect via `fromSeq`. REST and SSE keep
 * running on the same server untouched — Socket.IO only claims its own path.
 */
export function attachRealtimeGateway(options: AttachRealtimeGatewayOptions): RealtimeGateway {
  const { server, registry, resolveSession } = options;
  const io = new SocketIoServer(server, {
    path: options.path ?? "/socket.io/",
    serveClient: false,
    // Local-first; the HTTP API already sets permissive CORS for SSE.
    cors: { origin: true },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    // One live registry unsubscribe per logical session subscription. Keyed by
    // the id the client used so re-subscribe is idempotent and disconnect can
    // tear everything down without leaking listeners.
    const subscriptions = new Map<string, () => void>();

    socket.on("session:subscribe", async (payload: SubscribeRequest, ack?: (response: SubscribeAck) => void) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
      if (!sessionId) {
        ack?.({ ok: false, error: "session:subscribe requires a sessionId" });
        return;
      }
      const fromSeq = normalizeFromSeq(payload.fromSeq);

      let session: RegisteredSession;
      try {
        session = await resolveSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ack?.({ ok: false, error: /unknown session/i.test(message) ? `unknown session: ${sessionId}` : message });
        return;
      }

      // Idempotent: drop any prior subscription for this id before re-attaching
      // so we never deliver two copies of the same seq on one socket.
      subscriptions.get(sessionId)?.();
      subscriptions.delete(sessionId);

      const deliver = (event: PiEvent, seq: number) => {
        if (socket.connected) {
          const envelope: SessionEventEnvelope = { sessionId, seq, event };
          socket.emit("session:event", envelope);
        }
      };

      const lastSeq = registry.lastSeq(session.id);
      // The client claims to have seen further than the server's current top —
      // e.g. a worker restart reset the seq counter while a stale client still
      // holds a larger fromSeq. Tell it to resync (refetch state) instead of
      // letting it silently believe it is already caught up. The ring-gap
      // resync (fromSeq older than the buffer) is still handled by the
      // registry's subscribeFromSeq.
      if (fromSeq !== null && fromSeq > lastSeq) {
        deliver(
          { type: "session_resync", fromSeq, ringLowSeq: null, lastSeq } as unknown as PiEvent,
          lastSeq,
        );
      }

      const unsubscribe = registry.subscribeFromSeq(session.id, fromSeq, deliver);
      subscriptions.set(sessionId, unsubscribe);

      ack?.({ ok: true, sessionId, lastSeq });
    });

    socket.on("session:unsubscribe", (payload: { sessionId?: unknown }, ack?: (response: { ok: boolean }) => void) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
      if (sessionId) {
        subscriptions.get(sessionId)?.();
        subscriptions.delete(sessionId);
      }
      ack?.({ ok: true });
    });

    // --- PTY (browser Terminal tab) --------------------------------------
    // Each socket owns the ptys it opened so a disconnect tears them down (no
    // orphan shells). pty:data/pty:exit are forwarded only to the owning
    // socket, keyed by ptyId — zero cross-talk between terminals.
    const ownedPtys = new Set<string>();
    const ptyManager = options.ptyManager;
    let ptyDataUnsub: (() => void) | undefined;
    let ptyExitUnsub: (() => void) | undefined;
    if (ptyManager) {
      ptyDataUnsub = ptyManager.onData((event) => {
        if (ownedPtys.has(event.ptyId) && socket.connected) socket.emit("pty:data", event);
      });
      ptyExitUnsub = ptyManager.onExit((event) => {
        if (!ownedPtys.has(event.ptyId)) return;
        ownedPtys.delete(event.ptyId);
        if (socket.connected) socket.emit("pty:exit", event);
      });
    }

    socket.on("pty:open", async (payload: { sessionId?: unknown; cols?: unknown; rows?: unknown }, ack?: (response: unknown) => void) => {
      if (!ptyManager) { ack?.({ ok: false, error: "terminal disabled: no pty manager" }); return; }
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
      if (!sessionId) { ack?.({ ok: false, error: "pty:open requires a sessionId" }); return; }
      let session: RegisteredSession;
      try {
        session = await resolveSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ack?.({ ok: false, error: /unknown session/i.test(message) ? `unknown session: ${sessionId}` : message });
        return;
      }
      try {
        const cols = typeof payload.cols === "number" ? payload.cols : 80;
        const rows = typeof payload.rows === "number" ? payload.rows : 24;
        const ptyId = ptyManager.open({ cwd: session.cwd, cols, rows });
        ownedPtys.add(ptyId);
        ack?.({ ok: true, ptyId });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("pty:input", (payload: { ptyId?: unknown; data?: unknown }, ack?: (response: unknown) => void) => {
      const ptyId = typeof payload?.ptyId === "string" ? payload.ptyId : undefined;
      if (!ptyManager || !ptyId || !ownedPtys.has(ptyId)) { ack?.({ ok: false, error: "unknown pty" }); return; }
      ptyManager.input(ptyId, typeof payload.data === "string" ? payload.data : "");
      ack?.({ ok: true });
    });

    socket.on("pty:resize", (payload: { ptyId?: unknown; cols?: unknown; rows?: unknown }, ack?: (response: unknown) => void) => {
      const ptyId = typeof payload?.ptyId === "string" ? payload.ptyId : undefined;
      if (!ptyManager || !ptyId || !ownedPtys.has(ptyId)) { ack?.({ ok: false, error: "unknown pty" }); return; }
      ptyManager.resize(ptyId, Number(payload.cols), Number(payload.rows));
      ack?.({ ok: true });
    });

    socket.on("pty:close", (payload: { ptyId?: unknown }, ack?: (response: unknown) => void) => {
      const ptyId = typeof payload?.ptyId === "string" ? payload.ptyId : undefined;
      if (ptyManager && ptyId && ownedPtys.has(ptyId)) {
        ownedPtys.delete(ptyId);
        ptyManager.close(ptyId);
      }
      ack?.({ ok: true });
    });

    socket.on("disconnect", () => {
      for (const unsubscribe of subscriptions.values()) {
        try { unsubscribe(); } catch { /* listener teardown must not throw */ }
      }
      subscriptions.clear();
      // Kill any ptys this socket owned so a closed tab leaves no orphan shell.
      if (ptyManager) for (const ptyId of [...ownedPtys]) { try { ptyManager.close(ptyId); } catch { /* ignore */ } }
      ownedPtys.clear();
      ptyDataUnsub?.();
      ptyExitUnsub?.();
    });
  });

  return {
    io,
    stats() {
      return { connections: io.engine?.clientsCount ?? 0 };
    },
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

function normalizeFromSeq(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}
