/**
 * TerminalPanel — renders a wterm DOM terminal wired to a session-scoped pty
 * over the realtime transport. The wterm view and the transport are both
 * injectable so the unit suite can drive lifecycle logic without WASM or a
 * socket.
 *
 * Spec: docs/terminal-wterm-tdd-plan.md contract items 9–15.
 */
import React, { useEffect, useRef, useState } from "react";
import { WTerm } from "@wterm/dom";
import type { TerminalTransport } from "./terminal-transport.js";

/** Minimal terminal-view surface (a subset of @wterm/dom's WTerm). */
export interface TerminalView {
  init(): Promise<unknown>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  destroy(): void;
  cols: number;
  rows: number;
}

export interface TerminalViewHandlers {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export type CreateTerminalView = (host: HTMLElement, handlers: TerminalViewHandlers) => TerminalView;

export interface TerminalPanelProps {
  readonly sessionId: string;
  readonly transport: TerminalTransport;
  /** Whether this panel is the active tab. The pty is opened lazily on first
   *  activation, never before. */
  readonly active: boolean;
  /** Injectable wterm factory (defaults to the real @wterm/dom view). */
  readonly createView?: CreateTerminalView;
}

export function TerminalPanel(props: TerminalPanelProps): React.ReactElement {
  const { sessionId, transport, active } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const openedRef = useRef(false);
  const [exit, setExit] = useState<{ exitCode: number } | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);

  useEffect(() => {
    // Lazy open: do nothing until the tab is first activated.
    if (!active || openedRef.current) return;
    openedRef.current = true;
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const createView = props.createView ?? defaultCreateView;
    const view = createView(host, {
      onData: (data) => { if (ptyIdRef.current) transport.input(ptyIdRef.current, data); },
      onResize: (cols, rows) => { if (ptyIdRef.current) transport.resize(ptyIdRef.current, cols, rows); },
    });
    viewRef.current = view;

    const offData = transport.onData((event) => {
      if (event.ptyId === ptyIdRef.current) view.write(event.data);
    });
    const offExit = transport.onExit((event) => {
      if (event.ptyId === ptyIdRef.current) setExit({ exitCode: event.exitCode });
    });

    void Promise.resolve(view.init())
      .then(() => transport.open(sessionId, view.cols || 80, view.rows || 24))
      .then((ptyId) => {
        if (disposed) { transport.close(ptyId); return; }
        ptyIdRef.current = ptyId;
        view.focus();
      })
      .catch(() => { /* surfaced via exit banner / no-op for tests */ });

    return () => {
      disposed = true;
      offData();
      offExit();
      if (ptyIdRef.current) transport.close(ptyIdRef.current);
      ptyIdRef.current = null;
      openedRef.current = false;
      try { view.destroy(); } catch { /* ignore */ }
      viewRef.current = null;
    };
  // restartNonce re-runs the effect for an explicit user-driven restart.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, restartNonce]);

  return (
    <div className="terminal-panel" role="tabpanel" aria-label="Terminal">
      <div ref={hostRef} className="terminal-host" data-testid="wterm-root" />
      {exit ? (
        <div className="terminal-exit-banner" role="status">
          <span>Process exited (code {exit.exitCode})</span>
          <button
            type="button"
            onClick={() => { setExit(null); openedRef.current = false; setRestartNonce((n) => n + 1); }}
          >
            Restart
          </button>
        </div>
      ) : null}
    </div>
  );
}

const defaultCreateView: CreateTerminalView = (host, handlers) => {
  const term = new WTerm(host, {
    autoResize: true,
    onData: handlers.onData,
    onResize: handlers.onResize,
  });
  return term as unknown as TerminalView;
};
