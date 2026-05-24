import React from "react";

/**
 * Error boundary scoped to the active session's content area. Without this,
 * a throw inside any of the deeply-nested message/artifact/markdown
 * renderers propagates to the root and React unmounts the whole tree —
 * symptom: the sidebar flashes for ~half a second then the page goes blank
 * with no console-visible recovery path. (Observed on session 019e4de3-…
 * via a non-string children prop reaching react-markdown.)
 *
 * The boundary only wraps the right-hand session pane. The sidebar, header,
 * shortcut dialog, etc. stay mounted so the user can navigate away to a
 * different session that still renders. A reset button (keyed on
 * `resetKey`) lets the user retry after a transient error and we
 * auto-reset whenever the active session id changes.
 */
export interface SessionContentErrorBoundaryProps {
  readonly resetKey?: string;
  readonly children?: React.ReactNode;
}

interface State { error: Error | null }

export class SessionContentErrorBoundary extends React.Component<SessionContentErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: SessionContentErrorBoundaryProps): void {
    // Auto-reset when the caller switches to a different session.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log the full stack so we can find the offending render path.
    // eslint-disable-next-line no-console
    console.error("[session-content] render error", error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      const message = this.state.error.message || String(this.state.error);
      return (
        <div className="session-content-error" role="alert">
          <h2>Couldn't render this session</h2>
          <p>One of the messages failed to render. The other parts of the app are unaffected — you can switch to a different session in the sidebar or try again.</p>
          <details>
            <summary>Error details</summary>
            <pre>{message}</pre>
          </details>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
          >Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
