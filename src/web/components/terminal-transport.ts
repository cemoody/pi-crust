/**
 * TerminalTransport — the seam between the TerminalPanel React component and the
 * Socket.IO `pty:*` wire protocol. The real implementation wraps the shared
 * realtime socket; tests inject a FakeTerminalTransport so the panel's
 * open/input/resize/exit logic is verified DOM-free and WASM-free.
 *
 * Spec: docs/terminal-wterm-tdd-plan.md contract items 9–15.
 */

export interface TerminalTransport {
  /** Open a pty for the session. Resolves with the ptyId or rejects. */
  open(sessionId: string, cols: number, rows: number): Promise<string>;
  input(ptyId: string, data: string): void;
  resize(ptyId: string, cols: number, rows: number): void;
  close(ptyId: string): void;
  /** stdout/stderr chunks for an owned pty. Returns an unsubscribe. */
  onData(listener: (event: { ptyId: string; seq: number; data: string }) => void): () => void;
  /** Process exit. Returns an unsubscribe. */
  onExit(listener: (event: { ptyId: string; exitCode: number; signal?: number }) => void): () => void;
}
