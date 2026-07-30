// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InstalledExtensionsSection } from "../../src/web/components/InstalledExtensionsSection.js";
import type { ExtensionRegistryInfo } from "../../src/web/api/session-api.js";

function extensions(): ExtensionRegistryInfo {
  return {
    commands: [],
    activities: [
      { id: "core.viewer.activity", title: "Core viewer", extensionId: "core.viewer" },
      { id: "acme-tools.activity", title: "Acme tools", extensionId: "acme-tools" },
    ],
    settings: [],
    routes: [],
    diagnostics: [],
  };
}

describe("InstalledExtensionsSection", () => {
  it("keeps package ownership and enablement actions within the extracted settings section", () => {
    const onRun = vi.fn((_, action: () => Promise<void>) => { void action(); });
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(
      <InstalledExtensionsSection
        extensions={extensions()}
        disabled={new Set(["core.viewer"])}
        packageSources={["npm:acme-tools@1.2.3"]}
        updatesBySource={new Map()}
        source=""
        busy={null}
        onSourceChange={vi.fn()}
        onRun={onRun}
        onToggle={onToggle}
      />,
    );

    const section = screen.getByLabelText("Installed extensions");
    expect(within(section).getByText("from npm:acme-tools@1.2.3")).toBeInTheDocument();
    expect(within(section).getAllByText("Built-in")).toHaveLength(2);

    const coreToggle = within(section).getByLabelText("Core viewer") as HTMLInputElement;
    expect(coreToggle).not.toBeChecked();
    fireEvent.click(coreToggle);
    expect(onRun).toHaveBeenCalledWith("toggle:core.viewer", expect.any(Function), "Enabled core.viewer.");
    expect(onToggle).toHaveBeenCalledWith("core.viewer", true);
  });
});
