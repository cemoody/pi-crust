// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionContentErrorBoundary } from "../../src/web/components/SessionContentErrorBoundary.js";

/**
 * Pins the contract that a throw inside a session's content area produces a
 * scoped error UI WITHOUT unmounting the surrounding tree — the original
 * symptom of "page goes blank" we're protecting against.
 */

let originalError: typeof console.error;
beforeEach(() => {
  // React logs an error to the console whenever an ErrorBoundary catches
  // something; we suppress to keep test output focused.
  originalError = console.error;
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalError;
});

function Boom({ when }: { when: boolean }): React.JSX.Element {
  if (when) throw new Error("synthetic render failure");
  return <div data-testid="ok">ok</div>;
}

describe("SessionContentErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <SessionContentErrorBoundary resetKey="s1">
        <Boom when={false} />
      </SessionContentErrorBoundary>,
    );
    expect(screen.getByTestId("ok")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("catches a render error and shows a scoped alert (page does NOT go blank)", () => {
    render(
      <div>
        <span data-testid="sibling">sidebar stand-in</span>
        <SessionContentErrorBoundary resetKey="s1">
          <Boom when={true} />
        </SessionContentErrorBoundary>
      </div>,
    );
    // The boundary's alert UI is visible AND the sibling is still mounted.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Couldn't render this session/i)).toBeInTheDocument();
    expect(screen.getByTestId("sibling")).toBeInTheDocument();
  });

  it("auto-resets when resetKey changes (user switched to a different session)", () => {
    const { rerender } = render(
      <SessionContentErrorBoundary resetKey="s1">
        <Boom when={true} />
      </SessionContentErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Switch to a new resetKey AND render a non-throwing child — the
    // boundary should clear its error state.
    rerender(
      <SessionContentErrorBoundary resetKey="s2">
        <Boom when={false} />
      </SessionContentErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("ok")).toBeInTheDocument();
  });

  it("manual 'Try again' button clears the error and remounts children", () => {
    let shouldThrow = true;
    function Toggle(): React.JSX.Element {
      return <Boom when={shouldThrow} />;
    }
    const { rerender } = render(
      <SessionContentErrorBoundary resetKey="s1">
        <Toggle />
      </SessionContentErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Caller "fixes" the underlying problem and the user clicks Try again.
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    rerender(
      <SessionContentErrorBoundary resetKey="s1">
        <Toggle />
      </SessionContentErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("ok")).toBeInTheDocument();
  });
});

