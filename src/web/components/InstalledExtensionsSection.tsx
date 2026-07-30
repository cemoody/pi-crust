import { useMemo } from "react";
import { uniqueValues } from "../../shared/util.js";
import type {
  ExtensionRegistryInfo,
  ExtensionUpdateInfo,
} from "../api/session-api.js";

export interface InstalledExtensionsSectionProps {
  readonly extensions: ExtensionRegistryInfo;
  readonly disabled: ReadonlySet<string>;
  readonly packageSources: readonly string[];
  readonly updatesBySource: ReadonlyMap<string, ExtensionUpdateInfo>;
  readonly updatesLoading?: boolean | undefined;
  readonly source: string;
  readonly busy: string | null;
  readonly onSourceChange: (source: string) => void;
  readonly onRun: (label: string, action: () => Promise<void>, success?: string) => void;
  readonly onCheckUpdates?: (() => Promise<void>) | undefined;
  readonly onInstall?: ((source: string) => Promise<void>) | undefined;
  readonly onRemove?: ((source: string) => Promise<void>) | undefined;
  readonly onUpdate?: ((source: string) => Promise<void>) | undefined;
  readonly onToggle?: ((extensionId: string, enabled: boolean) => Promise<void>) | undefined;
}

/** The package/source controls and extension enablement registry in Settings. */
export function InstalledExtensionsSection({
  extensions,
  disabled,
  packageSources,
  updatesBySource,
  updatesLoading,
  source,
  busy,
  onSourceChange,
  onRun,
  onCheckUpdates,
  onInstall,
  onRemove,
  onUpdate,
  onToggle,
}: InstalledExtensionsSectionProps) {
  const extensionIds = useMemo(() => extensionIdsForSettings(extensions, disabled), [extensions, disabled]);

  return (
    <section id="extensions" className="settings-section" aria-label="Installed extensions">
      <div className="settings-section-head">
        <div>
          <h2>Extensions</h2>
          <div className="settings-section-desc">
            Sources install extensions (npm, git, or a local path). Each source can contribute one or more extensions, which you can toggle individually below. Built-in extensions ship with the binary and have no removable source.
          </div>
        </div>
        {onCheckUpdates ? (
          <button
            type="button"
            className="settings-btn ghost"
            disabled={busy !== null || updatesLoading}
            onClick={() => onRun("check-updates", onCheckUpdates, "Checked for updates.")}
          >{updatesLoading ? "Checking…" : "Check for updates"}</button>
        ) : null}
      </div>

      {onInstall ? (
        <SettingsRow
          label="Add a source"
          help={<>Install from <code className="chip">npm</code>, <code className="chip">git</code>, or a local path.</>}
        >
          <div className="settings-input-group">
            <input
              aria-label="Extension package source"
              className="settings-input mono"
              placeholder="npm:pkg, git:url, or local path"
              value={source}
              onChange={(event) => onSourceChange(event.target.value)}
            />
            <button
              type="button"
              className="settings-btn primary"
              disabled={!source.trim() || busy !== null}
              onClick={() => onRun("install", async () => {
                await onInstall(source.trim());
                onSourceChange("");
              }, "Source added and extensions reloaded.")}
            >{busy === "install" ? "Installing…" : "Add source"}</button>
          </div>
        </SettingsRow>
      ) : null}

      <SettingsRow label={<h4 className="settings-row-heading">Sources</h4>} help="Sources currently registered with the host.">
        {packageSources.length === 0 ? (
          <div className="settings-empty-card">
            <strong>No sources installed.</strong> Add one above to load more extensions.
          </div>
        ) : (
          <div>
            {packageSources.map((pkg) => {
              const update = updatesBySource.get(pkg);
              const canUpdate = update?.state === "update-available" && onUpdate;
              return (
                <div key={pkg} className="settings-pkg-row">
                  <code>{pkg}</code>
                  <UpdateBadge update={update} loading={updatesLoading} />
                  {canUpdate ? (
                    <button
                      type="button"
                      className="settings-btn sm primary"
                      aria-label={`Update ${pkg}`}
                      disabled={busy !== null}
                      onClick={() => onRun(`update:${pkg}`, () => onUpdate(pkg), `Updated ${pkg} and reloaded.`)}
                    >{busy === `update:${pkg}` ? "Updating…" : "Update"}</button>
                  ) : null}
                  {onRemove ? (
                    <button
                      type="button"
                      className="settings-btn sm"
                      disabled={busy !== null}
                      onClick={() => onRun(`remove:${pkg}`, () => onRemove(pkg), "Source removed and extensions reloaded.")}
                    >Remove</button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SettingsRow>

      <SettingsRow label="Loaded extensions" help="Built-in extensions ship with the binary and have no removable source.">
        {extensionIds.length === 0 ? (
          <div className="settings-empty-card"><strong>No extensions are configured.</strong></div>
        ) : (
          <div className="settings-ext-list" role="list">
            {extensionIds.map((extensionId) => {
              const activity = extensions.activities.find((entry) => entry.extensionId === extensionId);
              const title = activity?.title ?? extensionId;
              const diagnostics = extensions.diagnostics.filter((entry) => entry.extensionId === extensionId);
              const isOn = !disabled.has(extensionId);
              const sourceLabel = sourceLabelFor(extensionId, packageSources);
              const isBuiltIn = sourceLabel === "Built-in";
              return (
                <div key={extensionId} className="settings-ext-row" role="listitem">
                  <input
                    type="checkbox"
                    className="settings-switch"
                    aria-label={title}
                    checked={isOn}
                    disabled={!onToggle || busy !== null}
                    onChange={(event) => onRun(
                      `toggle:${extensionId}`,
                      () => onToggle!(extensionId, event.target.checked),
                      `${event.target.checked ? "Enabled" : "Disabled"} ${extensionId}.`,
                    )}
                  />
                  <div>
                    <div className="settings-ext-name">{title}</div>
                    <div className="settings-ext-source">
                      {title !== extensionId ? <><code>{extensionId}</code>{" "}</> : null}
                      <span className="settings-source-label">{sourceLabel}</span>
                    </div>
                    {diagnostics.length > 0 ? (
                      <div className="settings-ext-diag" role="alert">
                        {diagnostics.map((diagnostic) => diagnostic.message).join("; ")}
                      </div>
                    ) : null}
                  </div>
                  <span className={`settings-ext-tag ${isBuiltIn ? "built-in" : ""}`}>
                    {isBuiltIn ? "Built-in" : "Package"}
                  </span>
                  <div />
                </div>
              );
            })}
          </div>
        )}
      </SettingsRow>
    </section>
  );
}

interface SettingsRowProps {
  readonly label: React.ReactNode;
  readonly help?: React.ReactNode;
  readonly children: React.ReactNode;
}

function SettingsRow({ label, help, children }: SettingsRowProps) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        {help ? <div className="settings-row-help">{help}</div> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function UpdateBadge({ update, loading }: { update?: ExtensionUpdateInfo | undefined; loading?: boolean | undefined }) {
  if (update?.state === "local") return null;
  if (!update) {
    if (loading) return <span className="settings-update-badge checking" role="status" aria-busy="true">Checking…</span>;
    return null;
  }
  switch (update.state) {
    case "update-available":
      return <span className="settings-update-badge available">{update.installed ?? "?"} <span aria-hidden="true">→</span>{" "}<strong>{update.latest ?? "latest"}</strong><span className="sr-only"> update available</span></span>;
    case "up-to-date":
      return <span className="settings-update-badge current">Up to date</span>;
    case "pinned":
      return <span className="settings-update-badge pinned" title="Pinned to a specific version/ref">Pinned</span>;
    case "error":
    case "unknown":
      return <span className="settings-update-badge muted" title={update.message ?? ""}>Couldn’t check</span>;
    default:
      return null;
  }
}

export function extensionIdsForSettings(extensions: ExtensionRegistryInfo, disabled: ReadonlySet<string>): string[] {
  return uniqueValues([
    ...extensions.activities.map((activity) => activity.extensionId),
    ...extensions.commands.map((command) => command.extensionId),
    ...extensions.routes.map((route) => route.extensionId),
    ...extensions.diagnostics.map((diagnostic) => diagnostic.extensionId),
    ...(extensions.settings ?? []).map((section) => section.extensionId),
    ...disabled,
  ]).sort();
}

export function sourceLabelFor(extensionId: string, sources: readonly string[]): string {
  const match = sources.find((source) => extensionId.includes(packageBaseName(source)));
  return match ? `from ${match}` : "Built-in";
}

function packageBaseName(source: string): string {
  const stripped = source.replace(/^(?:npm|git):/, "");
  const at = stripped.lastIndexOf("@");
  return at > 0 ? stripped.slice(0, at) : stripped;
}
