/**
 * SessionTerminal — owns a SocketTerminalTransport for the active session and
 * renders the TerminalPanel. Kept separate so the socket + wterm WASM only load
 * when a Terminal tab is actually mounted.
 *
 * The transport is created and disposed inside an effect (not useMemo) so React
 * StrictMode's mount→unmount→remount cycle in dev gets a fresh, connected socket
 * each time instead of permanently disposing a memoized one.
 */
import React, { useEffect, useState } from "react";
import { TerminalPanel } from "./TerminalPanel.js";
import { createSocketTerminalTransport } from "../api/socket-terminal-transport.js";
import type { TerminalTransport } from "./terminal-transport.js";
import "./terminal-panel.css";

export interface SessionTerminalProps {
  readonly sessionId: string;
  readonly active: boolean;
}

export function SessionTerminal(props: SessionTerminalProps): React.ReactElement {
  const [transport, setTransport] = useState<(TerminalTransport & { dispose(): void }) | null>(null);

  useEffect(() => {
    const t = createSocketTerminalTransport();
    setTransport(t);
    return () => { t.dispose(); setTransport(null); };
  }, []);

  if (!transport) return <div className="terminal-panel" role="tabpanel" aria-label="Terminal"><div className="terminal-host" data-testid="wterm-root" /></div>;
  return <TerminalPanel sessionId={props.sessionId} transport={transport} active={props.active} />;
}
