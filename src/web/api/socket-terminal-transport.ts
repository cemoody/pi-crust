/**
 * SocketTerminalTransport — real TerminalTransport over a dedicated socket.io
 * connection speaking the `pty:*` wire protocol. Terminals are singular per
 * session tab (not the per-tab connection-budget problem the multiplexed
 * session gateway solves), so a focused dedicated socket keeps the lifecycle
 * simple and the teardown deterministic.
 *
 * Spec: docs/terminal-wterm-tdd-plan.md (wire protocol).
 */
import { io, type Socket } from "socket.io-client";
import type { TerminalTransport } from "../components/terminal-transport.js";

export interface SocketTerminalTransportOptions {
  readonly baseUrl?: string;
  readonly path?: string;
}

// Match the app's own realtime base so the terminal socket lands on the SAME
// origin as the session gateway (the Vite dev proxy's /socket.io passthrough
// is flaky for a second connection; connecting directly to the API base is
// what http-session-api does too).
const DEFAULT_BASE = (import.meta.env.VITE_PI_CRUST_API_BASE as string | undefined) || undefined;

export function createSocketTerminalTransport(options: SocketTerminalTransportOptions = {}): TerminalTransport & { dispose(): void } {
  const socket: Socket = io(options.baseUrl ?? DEFAULT_BASE, {
    path: options.path ?? "/socket.io/",
    transports: ["websocket", "polling"],
    reconnection: true,
  });

  const dataListeners = new Set<(e: { ptyId: string; seq: number; data: string }) => void>();
  const exitListeners = new Set<(e: { ptyId: string; exitCode: number; signal?: number }) => void>();
  socket.on("pty:data", (e) => { for (const l of [...dataListeners]) l(e); });
  socket.on("pty:exit", (e) => { for (const l of [...exitListeners]) l(e); });

  function emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 5_000);
      socket.emit(event, payload, (ack: T) => { clearTimeout(timer); resolve(ack); });
    });
  }

  return {
    async open(sessionId, cols, rows) {
      const ack = await emitWithAck<{ ok: boolean; ptyId?: string; error?: string }>("pty:open", { sessionId, cols, rows });
      if (!ack?.ok || !ack.ptyId) throw new Error(ack?.error ?? "pty:open failed");
      return ack.ptyId;
    },
    input(ptyId, data) { socket.emit("pty:input", { ptyId, data }); },
    resize(ptyId, cols, rows) { socket.emit("pty:resize", { ptyId, cols, rows }); },
    close(ptyId) { socket.emit("pty:close", { ptyId }); },
    onData(listener) { dataListeners.add(listener); return () => dataListeners.delete(listener); },
    onExit(listener) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    dispose() { try { socket.disconnect(); } catch { /* ignore */ } },
  };
}
