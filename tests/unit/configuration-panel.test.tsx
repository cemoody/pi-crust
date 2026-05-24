// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationPanel } from "../../src/web/components/ConfigurationPanel.js";

function renderPanel() {
  const handlers = {
    onLogin: vi.fn(), onLogout: vi.fn(), onApiKey: vi.fn(), onModelSelect: vi.fn(), onThinkingSelect: vi.fn(),
    onToolToggle: vi.fn(), onSaveSetting: vi.fn(), onReloadResources: vi.fn(), onPackageInstall: vi.fn(),
    onPackageRemove: vi.fn(), onThemeSelect: vi.fn(), onExtensionToggle: vi.fn(), onExtensionsReload: vi.fn(),
  };
  render(<ConfigurationPanel
    authProviders={[{ provider: "anthropic", status: "logged-out", warning: "extra usage may apply" }]}
    models={[{ provider: "anthropic", id: "claude", name: "Claude", available: true }, { provider: "openai", id: "gpt", name: "GPT", available: false, reason: "missing key" }]}
    thinkingLevel="medium"
    tools={[{ name: "read", enabled: true, source: "built-in" }, { name: "bash", enabled: false, source: "built-in" }]}
    settings={{ defaultModel: "claude", compaction: { enabled: true } }}
    resources={[{ kind: "extension", name: "demo", status: "error", detail: "boom" }, { kind: "context", name: "AGENTS.md", status: "loaded" }]}
    packages={[{ source: "npm:pi-tools", resources: ["extensions/demo.ts"] }]}
    themes={[{ name: "dark", tokens: { accent: "#fff" } }]}
    hotkeys={[{ action: "send", key: "Enter" }]}
    versions={[{ name: "pi", version: "0.74.0" }]}
    extensions={[{ id: "core.schedule", title: "Schedule", enabled: true, source: "bundled" }, { id: "bad", enabled: false, source: "project", diagnostics: ["boom"] }]}
    {...handlers}
  />);
  return handlers;
}

describe("ConfigurationPanel", () => {
  it("shows auth states and warning and handles login/logout/api key", () => {
    const handlers = renderPanel();
    expect(screen.getByLabelText("Auth panel")).toHaveTextContent("logged-out");
    expect(screen.getByLabelText("Auth panel")).toHaveTextContent("extra usage");
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    fireEvent.change(screen.getByLabelText("anthropic API key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
    expect(handlers.onLogin).toHaveBeenCalledWith("anthropic");
    expect(handlers.onLogout).toHaveBeenCalledWith("anthropic");
    expect(handlers.onApiKey).toHaveBeenCalledWith("anthropic", "sk-test");
  });

  it("selects available models and displays missing auth reason", () => {
    const handlers = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(handlers.onModelSelect).toHaveBeenCalledWith("anthropic", "claude");
    expect(screen.getByRole("button", { name: "GPT (missing key)" })).toBeDisabled();
  });

  it("changes thinking and toggles active tools", () => {
    const handlers = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "high" }));
    fireEvent.click(screen.getByLabelText(/bash/));
    expect(handlers.onThinkingSelect).toHaveBeenCalledWith("high");
    expect(handlers.onToolToggle).toHaveBeenCalledWith("bash", true);
  });

  it("renders and saves settings", () => {
    const handlers = renderPanel();
    expect(screen.getByLabelText("Settings panel")).toHaveTextContent("defaultModel");
    fireEvent.change(screen.getByLabelText("Setting key"), { target: { value: "theme" } });
    fireEvent.change(screen.getByLabelText("Setting value"), { target: { value: "dark" } });
    fireEvent.click(screen.getByRole("button", { name: "Save setting" }));
    expect(handlers.onSaveSetting).toHaveBeenCalledWith("theme", "dark");
  });

  it("shows extension settings, reloads extensions, and toggles extensions", () => {
    const handlers = renderPanel();
    expect(screen.getByLabelText("Extension management")).toHaveTextContent("Schedule (bundled)");
    expect(screen.getByLabelText("Extension management")).toHaveTextContent("bad (project)");
    expect(screen.getByLabelText("Extension management")).toHaveTextContent("boom");
    fireEvent.click(screen.getByRole("button", { name: "Reload extensions" }));
    fireEvent.click(screen.getByLabelText(/Schedule/));
    expect(handlers.onExtensionsReload).toHaveBeenCalled();
    expect(handlers.onExtensionToggle).toHaveBeenCalledWith("core.schedule", false);
  });

  it("handles themes, resources, packages, hotkeys, and versions", () => {
    const handlers = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload resources" }));
    fireEvent.click(screen.getByRole("button", { name: "Install package" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove package" }));
    expect(handlers.onThemeSelect).toHaveBeenCalledWith("dark");
    expect(handlers.onReloadResources).toHaveBeenCalled();
    expect(handlers.onPackageInstall).toHaveBeenCalledWith("npm:pi-package");
    expect(handlers.onPackageRemove).toHaveBeenCalledWith("npm:pi-tools");
    expect(screen.getByLabelText("Resource diagnostics")).toHaveTextContent("demo - error boom");
    expect(screen.getByLabelText("Hotkeys")).toHaveTextContent("send: Enter");
    expect(screen.getByLabelText("Changelog and versions")).toHaveTextContent("pi: 0.74.0");
  });
});

describe("presentation template directories section", () => {
  it("is no longer rendered by ConfigurationPanel — the presentations extension owns this UI now", () => {
    const onSaveSetting = vi.fn();
    const handlers = {
      onLogin: vi.fn(), onLogout: vi.fn(), onApiKey: vi.fn(), onModelSelect: vi.fn(), onThinkingSelect: vi.fn(),
      onToolToggle: vi.fn(), onSaveSetting, onReloadResources: vi.fn(), onPackageInstall: vi.fn(),
      onPackageRemove: vi.fn(), onThemeSelect: vi.fn(), onExtensionToggle: vi.fn(), onExtensionsReload: vi.fn(),
    };
    render(<ConfigurationPanel
      authProviders={[]}
      models={[]}
      thinkingLevel="medium"
      tools={[]}
      settings={{ presentations: { templateDirs: ["/a/b"] } }}
      resources={[]}
      packages={[]}
      themes={[]}
      hotkeys={[]}
      versions={[]}
      extensions={[]}
      {...handlers}
    />);
    expect(screen.queryByLabelText("Presentation template directories")).toBeNull();
    expect(screen.queryByLabelText("New template directory")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove /a/b" })).toBeNull();
    // Legacy dir must not leak out via any other UI surface here.
    expect(screen.queryByText("/a/b")).toBeNull();
    expect(onSaveSetting).not.toHaveBeenCalled();
  });
});
