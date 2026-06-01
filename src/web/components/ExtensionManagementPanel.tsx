import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppBrandingSettings,
  ExtensionRegistryInfo,
  ExtensionSettingsResponse,
  ExtensionSettingsSectionInfo,
  ExtensionUpdateInfo,
  SessionDashboardApi,
} from "../api/session-api.js";
import { ExternalWebSettingsSection } from "../extensions/external-web-settings-section.js";
import "./extension-settings-panel.css";

export interface ExtensionManagementPanelProps {
  readonly extensions: ExtensionRegistryInfo;
  readonly settings: ExtensionSettingsResponse | null;
  readonly currentAppName: string;
  readonly currentAppIcon?: string;
  /** Passed to contributed settings web modules so they can call host APIs. */
  readonly api?: SessionDashboardApi;
  readonly onSaveBranding?: (branding: AppBrandingSettings) => Promise<void>;
  readonly onReload: () => Promise<void>;
  readonly onToggle?: (extensionId: string, enabled: boolean) => Promise<void>;
  readonly onInstall?: (source: string) => Promise<void>;
  readonly onRemove?: (source: string) => Promise<void>;
  /** Per-source update statuses (lit up asynchronously after the page loads). */
  readonly updates?: readonly ExtensionUpdateInfo[];
  readonly updatesLoading?: boolean;
  /** Re-fetch a source to its latest version and reload. */
  readonly onUpdate?: (source: string) => Promise<void>;
  /** Trigger a background update check (called on mount and via the button). */
  readonly onCheckUpdates?: () => Promise<void>;
  readonly onSaveSetting?: (key: string, value: unknown) => Promise<void>;
  readonly onNotice?: (message: string) => void;
}

interface SubNavSection {
  readonly id: string;
  readonly label: string;
}

const CORE_SECTIONS: readonly SubNavSection[] = [
  { id: "branding", label: "App branding" },
  { id: "extensions", label: "Extensions" },
];

export function ExtensionManagementPanel(props: ExtensionManagementPanelProps) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appNameDraft, setAppNameDraft] = useState(props.settings?.appBranding?.appName ?? props.currentAppName);
  const [appIconUrlDraft, setAppIconUrlDraft] = useState(props.settings?.appBranding?.appIconUrl ?? props.currentAppIcon ?? "");
  const [activeSection, setActiveSection] = useState<string>(CORE_SECTIONS[0]!.id);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const tickingRef = useRef(false);

  const disabled = useMemo(() => new Set(props.settings?.disabledExtensions ?? []), [props.settings?.disabledExtensions]);
  const extensionIds = useMemo(() => extensionIdsForSettings(props.extensions, disabled), [props.extensions, disabled]);
  const packageSources = useMemo(() => {
    return [...(props.settings?.packages ?? [])].map((entry) => (typeof entry === "string" ? entry : ((entry as { source?: string }).source ?? JSON.stringify(entry))));
  }, [props.settings?.packages]);
  const updatesBySource = useMemo(() => {
    const map = new Map<string, ExtensionUpdateInfo>();
    for (const update of props.updates ?? []) map.set(update.source, update);
    return map;
  }, [props.updates]);
  const contributedSections = useMemo(
    () => sortContributedSections(props.extensions.settings ?? []),
    [props.extensions.settings],
  );

  const sections = useMemo<readonly SubNavSection[]>(() => [
    ...CORE_SECTIONS,
    ...contributedSections.map((s) => ({ id: `contrib-${s.id}`, label: s.title })),
  ], [contributedSections]);

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
    const appName = appNameDraft.trim() || "π crust";
    const appIconUrl = appIconUrlDraft.trim();
    await props.onSaveBranding({ appName, ...(appIconUrl ? { appIconUrl } : {}) });
  };

  const jumpTo = useCallback((id: string) => {
    const container = contentRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`#${cssEscape(id)}`);
    if (!target) return;
    container.scrollTo({ top: target.offsetTop - 8, behavior: "smooth" });
    setActiveSection(id);
  }, []);

  const onContentScroll = useCallback(() => {
    if (tickingRef.current) return;
    tickingRef.current = true;
    requestAnimationFrame(() => {
      const container = contentRef.current;
      if (container) {
        const cutoff = container.scrollTop + 80;
        let current = sections[0]!.id;
        for (const section of sections) {
          const el = container.querySelector<HTMLElement>(`#${cssEscape(section.id)}`);
          if (el && el.offsetTop <= cutoff) current = section.id;
        }
        setActiveSection(current);
      }
      tickingRef.current = false;
    });
  }, []);

  // Auto-check for updates once on mount. We deliberately read the callback
  // through a ref and use an empty dependency array: SessionDashboard passes a
  // fresh inline arrow on every render, so depending on the callback identity
  // would re-fire this effect forever (a flood of updates?force=1 requests).
  const { onCheckUpdates } = props;
  const onCheckUpdatesRef = useRef(onCheckUpdates);
  onCheckUpdatesRef.current = onCheckUpdates;
  useEffect(() => {
    void onCheckUpdatesRef.current?.();
  }, []);

  const previewIconChar = (appNameDraft.trim() || "π").charAt(0);
  const previewName = appNameDraft.trim() || "π crust";
  const previewIconUrl = appIconUrlDraft.trim();
  const brandingDisabled = !props.onSaveBranding || busy !== null;

  return (
    <div className="settings-page extension-settings-panel">
      <div className="settings-topbar">
        <div className="settings-crumbs" aria-label="Breadcrumb">
          <span>Account</span>
          <span>Settings</span>
        </div>
        <button
          type="button"
          className="settings-btn ghost"
          onClick={() => void run("reload", props.onReload, "Extensions reloaded.")}
          disabled={busy !== null}
        >
          <ReloadGlyph /> {busy === "reload" ? "Reloading…" : "Reload"}
        </button>
      </div>

      <header className="settings-page-head">
        <div>
          <h1>Settings</h1>
          <div className="settings-page-sub">
            Manage app branding, extension packages, enablement, and reload behavior for this workspace.
          </div>
        </div>
      </header>

      {error ? <p role="alert" className="dialog-error">{error}</p> : null}

      <div className="settings-body">
        <nav className="settings-subnav" aria-label="Settings sections">
          <div className="settings-subnav-label">Settings</div>
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={activeSection === section.id ? "active" : ""}
              onClick={(event) => { event.preventDefault(); jumpTo(section.id); }}
            >{section.label}</a>
          ))}
        </nav>

        <div className="settings-content" ref={contentRef} onScroll={onContentScroll}>

          {/* ===================== App branding ===================== */}
          <section id="branding" className="settings-section" aria-label="App branding">
            <div className="settings-section-head">
              <div>
                <h2>App branding</h2>
                <div className="settings-section-desc">
                  Custom name and icon shown in the title bar, dock, and shareable links.
                </div>
              </div>
              {props.onSaveBranding ? (
                <button
                  type="button"
                  className="settings-btn primary"
                  disabled={brandingDisabled}
                  onClick={() => void run("branding", saveBranding, "Branding saved.")}
                >{busy === "branding" ? "Saving…" : "Save branding"}</button>
              ) : null}
            </div>

            <Row label="App name" help="Shown wherever the product is named in the UI.">
              <input
                aria-label="App name"
                className="settings-input"
                value={appNameDraft}
                onChange={(event) => setAppNameDraft(event.target.value)}
                disabled={brandingDisabled}
              />
            </Row>

            <Row
              label="App icon"
              help={<>An image URL, absolute or relative path, or <code className="chip">data:</code> URL. Emoji and text icons are not supported.</>}
            >
              <div className="settings-field">
                <input
                  aria-label="App icon image URL"
                  className="settings-input mono"
                  placeholder="https://example.com/icon.svg"
                  value={appIconUrlDraft}
                  onChange={(event) => setAppIconUrlDraft(event.target.value)}
                  disabled={brandingDisabled}
                />
                <div className="settings-brand-preview" aria-label="Branding preview">
                  <div className="settings-brand-preview-icon">
                    {previewIconUrl
                      ? <img src={previewIconUrl} alt="" />
                      : <span>{previewIconChar}</span>}
                  </div>
                  <div className="settings-brand-preview-meta">
                    <div className="settings-brand-preview-name">{previewName}</div>
                    <div className="settings-brand-preview-cap">
                      {previewIconUrl ? "Custom icon" : "No icon — using fallback"}
                    </div>
                  </div>
                </div>
              </div>
            </Row>
          </section>

          {/* ===================== Extensions ===================== */}
          <section id="extensions" className="settings-section" aria-label="Installed extensions">
            <div className="settings-section-head">
              <div>
                <h2>Extensions</h2>
                <div className="settings-section-desc">
                  Sources install extensions (npm, git, or a local path). Each source can contribute one or more extensions, which you can toggle individually below. Built-in extensions ship with the binary and have no removable source.
                </div>
              </div>
              {props.onCheckUpdates ? (
                <button
                  type="button"
                  className="settings-btn ghost"
                  disabled={busy !== null || props.updatesLoading}
                  onClick={() => void run("check-updates", () => props.onCheckUpdates!(), "Checked for updates.")}
                >{props.updatesLoading ? "Checking…" : "Check for updates"}</button>
              ) : null}
            </div>

            {props.onInstall ? (
              <Row
                label="Add a source"
                help={<>Install from <code className="chip">npm</code>, <code className="chip">git</code>, or a local path.</>}
              >
                <div className="settings-input-group">
                  <input
                    aria-label="Extension package source"
                    className="settings-input mono"
                    placeholder="npm:pkg, git:url, or local path"
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                  />
                  <button
                    type="button"
                    className="settings-btn primary"
                    disabled={!source.trim() || busy !== null}
                    onClick={() => void run("install", async () => {
                      await props.onInstall!(source.trim());
                      setSource("");
                    }, "Source added and extensions reloaded.")}
                  >{busy === "install" ? "Installing…" : "Add source"}</button>
                </div>
              </Row>
            ) : null}

            <Row label={<h4 className="settings-row-heading">Sources</h4>} help="Sources currently registered with the host.">
              {packageSources.length === 0 ? (
                <div className="settings-empty-card">
                  <strong>No sources installed.</strong> Add one above to load more extensions.
                </div>
              ) : (
                <div>
                  {packageSources.map((pkg) => {
                    const update = updatesBySource.get(pkg);
                    const canUpdate = update?.state === "update-available" && props.onUpdate;
                    return (
                      <div key={pkg} className="settings-pkg-row">
                        <code>{pkg}</code>
                        <UpdateBadge update={update} loading={props.updatesLoading} />
                        {canUpdate ? (
                          <button
                            type="button"
                            className="settings-btn sm primary"
                            aria-label={`Update ${pkg}`}
                            disabled={busy !== null}
                            onClick={() => void run(`update:${pkg}`, () => props.onUpdate!(pkg), `Updated ${pkg} and reloaded.`)}
                          >{busy === `update:${pkg}` ? "Updating…" : "Update"}</button>
                        ) : null}
                        {props.onRemove ? (
                          <button
                            type="button"
                            className="settings-btn sm"
                            disabled={busy !== null}
                            onClick={() => void run(`remove:${pkg}`, () => props.onRemove!(pkg), "Source removed and extensions reloaded.")}
                          >Remove</button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </Row>

            <Row label="Loaded extensions" help="Built-in extensions ship with the binary and have no removable source.">
              {extensionIds.length === 0 ? (
                <div className="settings-empty-card">
                  <strong>No extensions are configured.</strong>
                </div>
              ) : (
                <div className="settings-ext-list" role="list">
                  {extensionIds.map((extensionId) => {
                    const activity = props.extensions.activities.find((a) => a.extensionId === extensionId);
                    const title = activity?.title ?? extensionId;
                    const diagnostics = props.extensions.diagnostics.filter((d) => d.extensionId === extensionId);
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
                          disabled={!props.onToggle || busy !== null}
                          onChange={(event) => void run(
                            `toggle:${extensionId}`,
                            () => props.onToggle!(extensionId, event.target.checked),
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
                              {diagnostics.map((d) => d.message).join("; ")}
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
            </Row>
          </section>

          {/* ===================== Contributed sections ===================== */}
          {contributedSections.length > 0 ? (
            <div aria-label="Contributed settings sections">
              {contributedSections.map((section) => (
                <section
                  key={section.id}
                  id={`contrib-${section.id}`}
                  className="settings-section"
                  aria-label={`Settings section: ${section.title}`}
                >
                  <div className="settings-section-head">
                    <div>
                      <h3 className="settings-section-title-h3">{section.title}</h3>
                      {section.description ? (
                        <div className="settings-section-desc">{section.description}</div>
                      ) : null}
                    </div>
                  </div>
                  <ExternalWebSettingsSection
                    section={section}
                    extensions={props.extensions}
                    api={props.api ?? ({} as SessionDashboardApi)}
                  />
                </section>
              ))}
            </div>
          ) : null}

        </div>
      </div>
    </div>
  );
}

interface RowProps {
  readonly label: React.ReactNode;
  readonly help?: React.ReactNode;
  readonly children: React.ReactNode;
}

function Row({ label, help, children }: RowProps) {
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
      return (
        <span className="settings-update-badge available">
          {update.installed ?? "?"} <span aria-hidden="true">→</span>{" "}
          <strong>{update.latest ?? "latest"}</strong>
          <span className="sr-only"> update available</span>
        </span>
      );
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

function ReloadGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function extensionIdsForSettings(extensions: ExtensionRegistryInfo, disabled: ReadonlySet<string>): string[] {
  return [...new Set([
    ...extensions.activities.map((activity) => activity.extensionId),
    ...extensions.commands.map((command) => command.extensionId),
    ...extensions.routes.map((route) => route.extensionId),
    ...extensions.diagnostics.map((diagnostic) => diagnostic.extensionId),
    ...(extensions.settings ?? []).map((section) => section.extensionId),
    ...disabled,
  ])].sort();
}

function sortContributedSections(
  sections: readonly ExtensionSettingsSectionInfo[],
): ExtensionSettingsSectionInfo[] {
  return [...sections].sort((a, b) => {
    const orderA = a.order ?? 0;
    const orderB = b.order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.title.localeCompare(b.title);
  });
}

function sourceLabelFor(extensionId: string, sources: readonly string[]): string {
  // Best-effort: built-in unless we can find an installed source that looks
  // like it provides this extension.
  const match = sources.find((s) => extensionId.includes(packageBaseName(s)));
  return match ? `from ${match}` : "Built-in";
}

function packageBaseName(source: string): string {
  const stripped = source.replace(/^(?:npm|git):/, "");
  const at = stripped.lastIndexOf("@");
  if (at > 0) return stripped.slice(0, at);
  return stripped;
}

function cssEscape(value: string): string {
  if (typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape === "function") {
    return (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
