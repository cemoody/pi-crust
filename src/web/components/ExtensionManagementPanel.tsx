import { useState } from "react";
import type { ExtensionRegistryInfo, ExtensionSettingsResponse } from "../api/session-api.js";

export interface ExtensionManagementPanelProps {
  readonly extensions: ExtensionRegistryInfo;
  readonly settings: ExtensionSettingsResponse | null;
  readonly onReload: () => Promise<void>;
  readonly onToggle?: (extensionId: string, enabled: boolean) => Promise<void>;
  readonly onInstall?: (source: string) => Promise<void>;
  readonly onRemove?: (source: string) => Promise<void>;
}

export function ExtensionManagementPanel(props: ExtensionManagementPanelProps) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const disabled = new Set(props.settings?.disabledExtensions ?? []);
  const extensionIds = extensionIdsForSettings(props.extensions, disabled);
  const packageSources = [...(props.settings?.packages ?? [])].map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry));
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try { await action(); }
    finally { setBusy(null); }
  };
  return (
    <div className="extension-settings-panel">
      <header>
        <div className="active-title">
          <h2>Extension settings</h2>
          <span className="active-subtitle">Manage packages, enablement, and reloads.</span>
        </div>
        <button type="button" onClick={() => void run("reload", props.onReload)} disabled={busy !== null}>{busy === "reload" ? "Reloading…" : "Reload"}</button>
      </header>
      <div className="extension-activity-body">
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
                  onChange={(event) => void run(`toggle:${extensionId}`, () => props.onToggle!(extensionId, event.target.checked))}
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
            <div className="popover-row">
              <input aria-label="Extension package source" placeholder="npm:pkg, git:url, or local path" value={source} onChange={(event) => setSource(event.target.value)} />
              <button type="button" disabled={!source.trim() || busy !== null} onClick={() => void run("install", async () => { await props.onInstall!(source.trim()); setSource(""); })}>Install</button>
            </div>
          ) : null}
          {packageSources.length === 0 ? <p>No packages installed.</p> : null}
          {packageSources.map((pkg) => (
            <p key={pkg}><code>{pkg}</code> {props.onRemove ? <button type="button" disabled={busy !== null} onClick={() => void run(`remove:${pkg}`, () => props.onRemove!(pkg))}>Remove</button> : null}</p>
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
