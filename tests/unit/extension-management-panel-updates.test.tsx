// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionManagementPanel } from "../../src/web/components/ExtensionManagementPanel.js";
import type { ExtensionRegistryInfo, ExtensionSettingsResponse, ExtensionUpdateInfo } from "../../src/web/api/session-api.js";

function makeExtensions(overrides: Partial<ExtensionRegistryInfo> = {}): ExtensionRegistryInfo {
  return { commands: [], activities: [], settings: [], routes: [], diagnostics: [], ...overrides };
}

function settingsWith(sources: readonly unknown[]): ExtensionSettingsResponse {
  return { packages: sources, extensions: makeExtensions() };
}

function baseHandlers() {
  return {
    onReload: vi.fn().mockResolvedValue(undefined),
    onNotice: vi.fn(),
  };
}

const npmSource = { source: "npm:demo", installedPath: "packages/npm/node_modules/demo", kind: "npm" as const };

function row(source: string) {
  return screen.getByText(source).closest(".settings-pkg-row") as HTMLElement;
}

describe("ExtensionManagementPanel — update affordances", () => {
  it("shows an update badge and an Update button for an out-of-date source", () => {
    const updates: ExtensionUpdateInfo[] = [
      { source: "npm:demo", kind: "npm", state: "update-available", pinned: false, installed: "1.0.0", latest: "2.0.0" },
    ];
    render(
      <ExtensionManagementPanel
        extensions={makeExtensions()}
        settings={settingsWith([npmSource])}
        currentAppName="π crust"
        updates={updates}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        {...baseHandlers()}
      />,
    );
    const r = row("npm:demo");
    expect(within(r).getByText(/1\.0\.0/)).toBeInTheDocument();
    expect(within(r).getByText(/2\.0\.0/)).toBeInTheDocument();
    expect(within(r).getByRole("button", { name: /update/i })).toBeEnabled();
  });

  it("shows 'up to date' and no Update button when current", () => {
    const updates: ExtensionUpdateInfo[] = [
      { source: "npm:demo", kind: "npm", state: "up-to-date", pinned: false, installed: "2.0.0", latest: "2.0.0" },
    ];
    render(
      <ExtensionManagementPanel extensions={makeExtensions()} settings={settingsWith([npmSource])} currentAppName="π" updates={updates} onUpdate={vi.fn()} {...baseHandlers()} />,
    );
    const r = row("npm:demo");
    expect(within(r).getByText(/up to date/i)).toBeInTheDocument();
    expect(within(r).queryByRole("button", { name: /^update$/i })).toBeNull();
  });

  it("marks pinned sources as pinned with no Update button", () => {
    const updates: ExtensionUpdateInfo[] = [
      { source: "npm:demo@1.0.0", kind: "npm", state: "pinned", pinned: true, installed: "1.0.0" },
    ];
    render(
      <ExtensionManagementPanel extensions={makeExtensions()} settings={settingsWith([{ source: "npm:demo@1.0.0", kind: "npm" }])} currentAppName="π" updates={updates} onUpdate={vi.fn()} {...baseHandlers()} />,
    );
    const r = row("npm:demo@1.0.0");
    expect(within(r).getByText(/pinned/i)).toBeInTheDocument();
    expect(within(r).queryByRole("button", { name: /^update$/i })).toBeNull();
  });

  it("shows a muted 'couldn't check' state on error without crashing", () => {
    const updates: ExtensionUpdateInfo[] = [
      { source: "npm:demo", kind: "npm", state: "error", pinned: false, message: "network down" },
    ];
    render(
      <ExtensionManagementPanel extensions={makeExtensions()} settings={settingsWith([npmSource])} currentAppName="π" updates={updates} onUpdate={vi.fn()} {...baseHandlers()} />,
    );
    expect(within(row("npm:demo")).getByText(/couldn.t check/i)).toBeInTheDocument();
  });

  it("calls onUpdate exactly once with the source when Update is clicked", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const updates: ExtensionUpdateInfo[] = [
      { source: "npm:demo", kind: "npm", state: "update-available", pinned: false, installed: "1.0.0", latest: "2.0.0" },
    ];
    render(
      <ExtensionManagementPanel extensions={makeExtensions()} settings={settingsWith([npmSource])} currentAppName="π" updates={updates} onUpdate={onUpdate} {...baseHandlers()} />,
    );
    fireEvent.click(within(row("npm:demo")).getByRole("button", { name: /update/i }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith("npm:demo");
  });

  it("kicks off a background update check on mount", () => {
    const onCheckUpdates = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtensionManagementPanel extensions={makeExtensions()} settings={settingsWith([npmSource])} currentAppName="π" onCheckUpdates={onCheckUpdates} {...baseHandlers()} />,
    );
    expect(onCheckUpdates).toHaveBeenCalledTimes(1);
  });

  it("auto-checks exactly once even when the onCheckUpdates prop identity changes every render", () => {
    // Regression: SessionDashboard passes an inline `() => check()` arrow, so
    // onCheckUpdates is a new function each render. A naive [onCheckUpdates]
    // effect dep then re-fires forever (observed as a flood of updates?force=1
    // requests). The mount auto-check must be run-once regardless of identity.
    const handlers = baseHandlers();
    const calls: number[] = [];
    const renderOnce = () => {
      const onCheckUpdates = vi.fn(() => { calls.push(1); return Promise.resolve(); });
      return (
        <ExtensionManagementPanel extensions={makeExtensions()} settings={settingsWith([npmSource])} currentAppName="π" onCheckUpdates={onCheckUpdates} {...handlers} />
      );
    };
    const { rerender } = render(renderOnce());
    rerender(renderOnce());
    rerender(renderOnce());
    rerender(renderOnce());
    expect(calls).toHaveLength(1);
  });

  it("renders the source list even when no update info is available yet", () => {
    render(
      <ExtensionManagementPanel extensions={makeExtensions()} settings={settingsWith([npmSource])} currentAppName="π" updatesLoading {...baseHandlers()} />,
    );
    expect(screen.getByText("npm:demo")).toBeInTheDocument();
    expect(within(row("npm:demo")).getByText(/checking/i)).toBeInTheDocument();
  });

  it("offers a global 'Check for updates' control that calls onCheckUpdates", () => {
    const onCheckUpdates = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtensionManagementPanel extensions={makeExtensions()} settings={settingsWith([npmSource])} currentAppName="π" onCheckUpdates={onCheckUpdates} {...baseHandlers()} />,
    );
    onCheckUpdates.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));
    expect(onCheckUpdates).toHaveBeenCalled();
  });
});
