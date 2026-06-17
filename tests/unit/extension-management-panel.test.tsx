// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionManagementPanel } from "../../src/web/components/ExtensionManagementPanel.js";
import type {
  ExtensionRegistryInfo,
  ExtensionSettingsResponse,
} from "../../src/web/api/session-api.js";

function makeExtensions(overrides: Partial<ExtensionRegistryInfo> = {}): ExtensionRegistryInfo {
  return {
    commands: [],
    activities: [],
    settings: [],
    routes: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeHandlers() {
  return {
    onReload: vi.fn().mockResolvedValue(undefined),
    onToggle: vi.fn().mockResolvedValue(undefined),
    onInstall: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onSaveSetting: vi.fn().mockResolvedValue(undefined),
    onSaveBranding: vi.fn().mockResolvedValue(undefined),
    onNotice: vi.fn(),
  };
}

describe("ExtensionManagementPanel — no hardcoded presentation UI", () => {
  it("does not render the legacy hardcoded 'Presentation templates' section", () => {
    const h = makeHandlers();
    render(
      <ExtensionManagementPanel
        extensions={makeExtensions()}
        settings={null}
        currentAppName="π crust"
        {...h}
      />,
    );
    // The whole section, its help copy, and its input must be gone — those are
    // owned by the presentations extension now, not by pi-crust core.
    expect(screen.queryByRole("heading", { name: /presentation templates/i })).toBeNull();
    expect(screen.queryByText(/core\.presentations/i)).toBeNull();
    expect(screen.queryByLabelText(/new presentation template directory/i)).toBeNull();
    expect(screen.queryByPlaceholderText("/path/to/templates")).toBeNull();
  });

  it("does not render a hardcoded section even when presentations.templateDirs is set in settings", () => {
    const h = makeHandlers();
    const settings: ExtensionSettingsResponse = {
      presentations: { templateDirs: ["/legacy/dir"] },
      extensions: makeExtensions(),
    };
    render(
      <ExtensionManagementPanel
        extensions={makeExtensions()}
        settings={settings}
        currentAppName="π crust"
        {...h}
      />,
    );
    expect(screen.queryByRole("heading", { name: /presentation templates/i })).toBeNull();
    // The legacy dir should not surface anywhere in the panel — only the
    // contributed settings module is allowed to render it.
    expect(screen.queryByText("/legacy/dir")).toBeNull();
  });
});

describe("ExtensionManagementPanel — contributed settings sections", () => {
  it("renders one section per contributed entry, sorted by (order, title)", async () => {
    const h = makeHandlers();
    const renderer = (label: string) =>
      `data:text/javascript,${encodeURIComponent(
        `export function renderSettingsSection(p){return p.React.createElement('span',{'data-testid':'sec-body'}, ${JSON.stringify(label)});}`,
      )}`;

    const extensions = makeExtensions({
      settings: [
        { id: "ext.z.cfg", title: "Zulu", order: 10, extensionId: "ext.z", webModuleUrl: renderer("Z") },
        { id: "ext.a.cfg", title: "Alpha", order: 10, extensionId: "ext.a", webModuleUrl: renderer("A") },
        { id: "ext.first.cfg", title: "First", order: 5, extensionId: "ext.first", webModuleUrl: renderer("F") },
      ],
    });

    render(
      <ExtensionManagementPanel
        extensions={extensions}
        settings={{ extensions }}
        currentAppName="π crust"
        {...h}
      />,
    );

    const headings = screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent ?? "");
    // Sections should appear in order First (5), Alpha (10/Alpha), Zulu (10/Zulu);
    // App branding / Extensions headings may interleave — we just assert relative order.
    const idxFirst = headings.findIndex((t) => t.includes("First"));
    const idxAlpha = headings.findIndex((t) => t.includes("Alpha"));
    const idxZulu = headings.findIndex((t) => t.includes("Zulu"));
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxAlpha).toBeGreaterThan(idxFirst);
    expect(idxZulu).toBeGreaterThan(idxAlpha);

    // Each contributed module renders into the page once loaded.
    const bodies = await screen.findAllByTestId("sec-body");
    expect(bodies.map((b) => b.textContent).sort()).toEqual(["A", "F", "Z"]);
  });

  it("renders nothing extra when no extensions contribute a settings section", () => {
    const h = makeHandlers();
    render(
      <ExtensionManagementPanel
        extensions={makeExtensions()}
        settings={{ extensions: makeExtensions() }}
        currentAppName="π crust"
        {...h}
      />,
    );
    // No section with the contributed-section landmark should exist.
    expect(screen.queryByLabelText("Contributed settings sections")).toBeNull();
  });

  it("renders a benign placeholder for contributed sections with no webModuleUrl", () => {
    const h = makeHandlers();
    const extensions = makeExtensions({
      settings: [
        { id: "ui-less.cfg", title: "UI-less", extensionId: "ui-less" },
      ],
    });
    render(
      <ExtensionManagementPanel
        extensions={extensions}
        settings={{ extensions }}
        currentAppName="π crust"
        {...h}
      />,
    );
    expect(screen.getByRole("heading", { name: /UI-less/i })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ExtensionManagementPanel — packages vs extensions copy", () => {
  it("uses a single short blurb that frames packages as 'sources' for extensions", () => {
    const h = makeHandlers();
    render(
      <ExtensionManagementPanel
        extensions={makeExtensions()}
        settings={{ packages: [], extensions: makeExtensions() }}
        currentAppName="π crust"
        {...h}
      />,
    );
    const ext = screen.getByLabelText(/installed extensions/i);
    // The new copy explains the relationship in one sentence and uses the
    // word "sources" so it lines up with the subhead.
    expect(ext.textContent ?? "").toMatch(/sources install extensions/i);
    expect(ext.textContent ?? "").toMatch(/toggle/i);
  });

  it("renders package sources under a 'Sources' subhead (not 'Installed packages')", () => {
    const h = makeHandlers();
    render(
      <ExtensionManagementPanel
        extensions={makeExtensions()}
        settings={{ packages: ["npm:pi-tools"], extensions: makeExtensions() }}
        currentAppName="π crust"
        {...h}
      />,
    );
    const ext = screen.getByLabelText(/installed extensions/i);
    expect(within(ext).getByRole("heading", { name: /^sources$/i })).toBeInTheDocument();
    expect(within(ext).queryByRole("heading", { name: /^installed packages$/i })).toBeNull();
    expect(within(ext).getByText("npm:pi-tools")).toBeInTheDocument();
    expect(within(ext).getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
  });
});

describe("ExtensionManagementPanel — unified extension list", () => {
  it("shows extensions with a source label (built-in vs from <package>) and toggles", async () => {
    const h = makeHandlers();
    const extensions = makeExtensions({
      activities: [
        { id: "core.builtin.view", title: "Built-in View", extensionId: "core.builtin" },
        { id: "third.party.view", title: "Third-Party View", extensionId: "third.party" },
      ],
    });
    render(
      <ExtensionManagementPanel
        extensions={extensions}
        settings={{
          packages: ["npm:third-party"],
          extensions,
        }}
        currentAppName="π crust"
        {...h}
      />,
    );

    const ext = screen.getByLabelText(/installed extensions/i);
    // Each extension row carries a source label distinct from the help blurb.
    const sourceLabels = ext.querySelectorAll(".settings-source-label");
    expect(sourceLabels.length).toBeGreaterThanOrEqual(2);
    const labelTexts = [...sourceLabels].map((node) => node.textContent ?? "");
    expect(labelTexts).toContain("Built-in");

    // Toggling an extension still calls the existing handler with (id, enabled).
    fireEvent.click(within(ext).getByLabelText(/built-in view/i));
    expect(h.onToggle).toHaveBeenCalledWith("core.builtin", false);
  });
});

describe("ExtensionManagementPanel — global system prompt", () => {
  it("renders the current global system prompt and saves edits via onSaveSetting", async () => {
    const h = makeHandlers();
    render(
      <ExtensionManagementPanel
        extensions={makeExtensions()}
        settings={{ globalSystemPrompt: "old prompt", extensions: makeExtensions() }}
        currentAppName="π crust"
        {...h}
      />,
    );

    const textarea = screen.getByPlaceholderText(/In-scope CLI tools/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("old prompt");

    // The Save button is disabled until the draft differs from the saved value.
    const saveButton = screen.getByRole("button", { name: /save prompt/i });
    expect(saveButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "In-scope CLI tools: gh, kubectl." } });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    expect(h.onSaveSetting).toHaveBeenCalledWith("globalSystemPrompt", "In-scope CLI tools: gh, kubectl.");
  });
});
