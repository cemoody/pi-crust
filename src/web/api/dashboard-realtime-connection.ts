import { io as socketIoClient } from "socket.io-client";
import { getTabSessionId, recordClientEvent } from "../utils/client-telemetry.js";
import { createRealtimeConnection, type RealtimeConnection, type RealtimeTransport } from "./realtime-connection.js";

interface DashboardRealtimeConnectionOptions {
  readonly apiBase: string;
}

const lazyIo = () => socketIoClient;

/**
 * Creates the dashboard's multiplexed Socket.IO connection for a browser tab.
 *
 * The HTTP API owns request methods; this factory owns the browser-specific
 * transport, leader-election dependencies, and telemetry wiring used by its
 * realtime stream. Keeping that setup here makes the API's stream method a
 * transport selection seam rather than a second connection implementation.
 */
export function createDashboardRealtimeConnection({ apiBase }: DashboardRealtimeConnectionOptions): RealtimeConnection {
  const transportFactory = (): RealtimeTransport => {
    const socket = lazyIo()(apiBase || undefined, {
      path: "/socket.io/",
      transports: ["websocket", "polling"],
      autoConnect: false,
    });
    return {
      get connected() { return socket.connected; },
      connect() { socket.connect(); },
      disconnect() { socket.disconnect(); },
      on: (event, handler) => { socket.on(event as never, handler as never); },
      off: (event, handler) => { socket.off(event as never, handler as never); },
      emit: (event, payload, ack) => {
        if (ack) socket.emit(event as never, payload as never, ack as never);
        else socket.emit(event as never, payload as never);
      },
    };
  };
  const broadcast = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pi-crust-realtime") : undefined;
  const visibility = typeof document !== "undefined" ? {
    isVisible: () => document.visibilityState === "visible",
    subscribe: (callback: () => void) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
  } : undefined;

  return createRealtimeConnection({
    transportFactory,
    // An empty or duplicated tab id breaks leader election; the connection
    // creates a unique id when telemetry has not initialized one yet.
    tabId: getTabSessionId() || undefined,
    broadcast,
    visibility,
    onClientEvent: (event) => recordClientEvent(event),
  } as Parameters<typeof createRealtimeConnection>[0]);
}
