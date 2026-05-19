import { useEffect, useState } from "react";
import type { AppBrandingSettings, ExtensionRegistryInfo, ExtensionSettingsResponse } from "../api/session-api.js";

export interface ExtensionManagementPanelProps {
  readonly extensions: ExtensionRegistryInfo;
  readonly settings: ExtensionSettingsResponse | null;
  readonly currentAppName: string;
  readonly currentAppIcon?: string;
  readonly onSaveBranding?: (branding: AppBrandingSettings) => Promise<void>;
  readonly onReload: () => Promise<void>;
  readonly onToggle?: (extensionId: string, enabled: boolean) => Promise<void>;
  readonly onInstall?: (source: string) => Promise<void>;
  readonly onRemove?: (source: string) => Promise<void>;
  readonly onNotice?: (message: string) => void;
}

export function ExtensionManagementPanel(props: ExtensionManagementPanelProps) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const disabled = new Set(props.settings?.disabledExtensions ?? []);
  const extensionIds = extensionIdsForSettings(props.extensions, disabled);
  const packageSources = [...(props.settings?.packages ?? [])].map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry));
  const [error, setError] = useState<string | null>(null);
  const [appNameDraft, setAppNameDraft] = useState(props.settings?.appBranding?.appName ?? props.currentAppName);
  const [appIconUrlDraft, setAppIconUrlDraft] = useState(props.settings?.appBranding?.appIconUrl ?? props.currentAppIcon ?? "");

  useEffect(() => {
    setAppNameDraft(props.settings?.appBranding?.appName ?? props.currentAppName);
    setAppIconUrlDraft(props.settings?.appBranding?.appIconUrl ?? props.currentAppIcon ?? "");
  }, [props.settings?.appBranding?.appName, props.settings?.appBranding?.appIconUrl, props.currentAppName, props.currentAppIcon]);

  const run = async (label: string, action: () => Promise<void>, success?: string) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      if (success) props.onNotice?.(success);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const saveBranding = async () => {
    if (!props.onSaveBranding) return;
    const appName = appNameDraft.trim() || "pi remote";
    const appIconUrl = appIconUrlDraft.trim();
    await props.onSaveBranding({ appName, ...(appIconUrl ? { appIconUrl } : {}) });
  };

  return (
    <div className="extension-settings-panel">
      <header>
        <div className="active-title">
          <h2>Settings</h2>
          <span className="active-subtitle">Manage app branding, extension packages, enablement, and reloads.</span>
        </div>
        <button type="button" onClick={() => void run("reload", props.onReload, "Extensions reloaded.")} disabled={busy !== null}>{busy === "reload" ? "Reloading…" : "Reload"}</button>
      </header>
      {error ? <p role="alert" className="dialog-error">{error}</p> : null}
      <div className="extension-activity-body">
        <section aria-label="App branding">
          <h3>App branding</h3>
          <div className="branding-settings-grid">
            <label>
              <span>App name</span>
              <input aria-label="App name" value={appNameDraft} onChange={(event) => setAppNameDraft(event.target.value)} disabled={!props.onSaveBranding || busy !== null} />
            </label>
            <label>
              <span>App icon image URL</span>
              <input aria-label="App icon image URL" placeholder="https://example.com/icon.svg or /icon.png" value={appIconUrlDraft} onChange={(event) => setAppIconUrlDraft(event.target.value)} disabled={!props.onSaveBranding || busy !== null} />
            </label>
            <div className="branding-preview" aria-label="Branding preview">
              {appIconUrlDraft.trim() ? <img className="branding-icon-preview" src={appIconUrlDraft.trim()} alt="" /> : <span className="branding-icon-empty">No icon</span>}
              <strong>{appNameDraft.trim() || "pi remote"}</strong>
            </div>
            <button type="button" disabled={!props.onSaveBranding || busy !== null} onClick={() => void run("branding", saveBranding, "Branding saved.")}>{busy === "branding" ? "Saving…" : "Save branding"}</button>
          </div>
          <p className="settings-help">Use an image URL, absolute/relative path, or data:image URL. Emoji/text icons are not supported for app branding.</p>
        </section>
        <section aria-label="Installed extensions">
          <h3>Extensions</h3>
          {extensionIds.length === 0 ? <p>No extensions are configured.</p> : null}
          {extensionIds.map((extensionId) => {
            const title = props.extensions.activities.find((activity) => activity.extensionId === extensionId)?.title ?? extensionId;
            const diagnostics = props.extensions.diagnostics.filter((diagnostic) => diagnostic.extensionId === extensionId);
            return (
              <label key={extensionId} className="popover-row checkbox-row">
                <input
                  type="checkbox"
                  checked={!disabled.has(extensionId)}
                  disabled={!props.onToggle || busy !== null}
                  onChange={(event) => void run(`toggle:${extensionId}`, () => props.onToggle!(extensionId, event.target.checked), `${event.target.checked ? "Enabled" : "Disabled"} ${extensionId}.`)}
                />
                <span>{title} <code>{extensionId}</code></span>
                {diagnostics.length > 0 ? <span role="alert"> {diagnostics.map((diagnostic) => diagnostic.message).join("; ")}</span> : null}
              </label>
            );
          })}
        </section>
        <section aria-label="Extension packages">
          <h3>Packages</h3>
          {props.onInstall ? (
            <div className="extension-package-install-row">
              <input aria-label="Extension package source" placeholder="npm:pkg, git:url, or local path" value={source} onChange={(event) => setSource(event.target.value)} />
              <button type="button" disabled={!source.trim() || busy !== null} onClick={() => void run("install", async () => { await props.onInstall!(source.trim()); setSource(""); }, "Extension installed and reloaded.")}>{busy === "install" ? "Installing…" : "Install"}</button>
            </div>
          ) : null}
          {packageSources.length === 0 ? <p>No packages installed.</p> : null}
          {packageSources.map((pkg) => (
            <p key={pkg} className="extension-package-row"><code>{pkg}</code> {props.onRemove ? <button type="button" disabled={busy !== null} onClick={() => void run(`remove:${pkg}`, () => props.onRemove!(pkg), "Extension package removed and reloaded.")}>Remove</button> : null}</p>
          ))}
        </section>
      </div>
    </div>
  );
}

function extensionIdsForSettings(extensions: ExtensionRegistryInfo, disabled: ReadonlySet<string>): string[] {
  return [...new Set([
    ...extensions.activities.map((activity) => activity.extensionId),
    ...extensions.commands.map((command) => command.extensionId),
    ...extensions.routes.map((route) => route.extensionId),
    ...extensions.diagnostics.map((diagnostic) => diagnostic.extensionId),
    ...disabled,
  ])].sort();
}
