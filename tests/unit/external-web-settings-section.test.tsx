// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExternalWebSettingsSection } from "../../src/web/extensions/external-web-settings-section.js";
import type {
  ExtensionRegistryInfo,
  ExtensionSettingsSectionInfo,
  SessionDashboardApi,
} from "../../src/web/api/session-api.js";

const EMPTY_EXTENSIONS: ExtensionRegistryInfo = {
  commands: [],
  activities: [],
  settings: [],
  routes: [],
  diagnostics: [],
};

describe("ExternalWebSettingsSection", () => {
  it("dynamically imports and renders an external settings-section module", async () => {
    const source =
      "export function renderSettingsSection(props) {" +
      " return props.React.createElement('strong', null, `Section ${props.section.title}`);" +
      " }";
    const section: ExtensionSettingsSectionInfo = {
      id: "core.presentations.settings",
      title: "Presentations",
      extensionId: "core.presentations",
      webModuleUrl: `data:text/javascript,${encodeURIComponent(source)}`,
    };

    render(
      <ExternalWebSettingsSection
        section={section}
        extensions={EMPTY_EXTENSIONS}
        api={{} as SessionDashboardApi}
      />,
    );

    expect(await screen.findByText("Section Presentations")).toBeInTheDocument();
  });

  it("shows an error when the web module exports no renderer", async () => {
    const section: ExtensionSettingsSectionInfo = {
      id: "bad.section",
      title: "Bad",
      extensionId: "bad",
      webModuleUrl: "data:text/javascript,export%20const%20x%20%3D%201%3B",
    };

    render(
      <ExternalWebSettingsSection
        section={section}
        extensions={EMPTY_EXTENSIONS}
        api={{} as SessionDashboardApi}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("does not export a renderer");
  });

  it("renders a 'no UI provided' placeholder for sections without a web module url", () => {
    const section: ExtensionSettingsSectionInfo = {
      id: "ui-less.section",
      title: "UI-less",
      extensionId: "ui-less",
    };

    render(
      <ExternalWebSettingsSection
        section={section}
        extensions={EMPTY_EXTENSIONS}
        api={{} as SessionDashboardApi}
      />,
    );

    // Not an error — just a benign placeholder noting the contributing extension.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/no settings ui provided/i)).toBeInTheDocument();
    expect(screen.getByText(/ui-less/)).toBeInTheDocument();
  });
});
