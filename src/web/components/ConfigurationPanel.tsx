import { useState } from "react";
import "./configuration-panel.css";

export interface ModelInfo { readonly provider: string; readonly id: string; readonly name: string; readonly available: boolean; readonly reason?: string; }
export interface ToolInfo { readonly name: string; readonly enabled: boolean; readonly source: "built-in" | "extension" | "custom"; }
export interface ResourceDiagnostic { readonly kind: string; readonly name: string; readonly status: "loaded" | "error"; readonly detail?: string; }
export interface PackageInfo { readonly source: string; readonly resources: readonly string[]; }
export interface ThemeInfo { readonly name: string; readonly tokens: Record<string, string>; }
export interface ExtensionSettingsInfo {
  readonly id: string;
  readonly title?: string;
  readonly enabled: boolean;
  readonly source: "built-in" | "bundled" | "project" | "global" | "explicit";
  readonly diagnostics?: readonly string[];
}

export interface ConfigurationPanelProps {
  readonly authProviders: readonly { readonly provider: string; readonly status: "logged-in" | "logged-out" | "api-key"; readonly warning?: string }[];
  readonly models: readonly ModelInfo[];
  readonly thinkingLevel: string;
  readonly tools: readonly ToolInfo[];
  readonly settings: Record<string, unknown>;
  readonly resources: readonly ResourceDiagnostic[];
  readonly packages: readonly PackageInfo[];
  readonly themes: readonly ThemeInfo[];
  readonly hotkeys: readonly { readonly action: string; readonly key: string }[];
  readonly versions: readonly { readonly name: string; readonly version: string }[];
  readonly extensions?: readonly ExtensionSettingsInfo[];
  readonly onLogin: (provider: string) => void;
  readonly onLogout: (provider: string) => void;
  readonly onApiKey: (provider: string, key: string) => void;
  readonly onModelSelect: (provider: string, modelId: string) => void;
  readonly onThinkingSelect: (level: string) => void;
  readonly onToolToggle: (name: string, enabled: boolean) => void;
  readonly onSaveSetting: (key: string, value: unknown) => void;
  readonly onReloadResources: () => void;
  readonly onPackageInstall: (source: string) => void;
  readonly onPackageRemove: (source: string) => void;
  readonly onThemeSelect: (name: string) => void;
  readonly onExtensionToggle?: (id: string, enabled: boolean) => void;
  readonly onExtensionsReload?: () => void;
}

function getTemplateDirs(settings: Record<string, unknown>): readonly string[] {
  const presentations = settings.presentations;
  if (!presentations || typeof presentations !== "object") return [];
  const dirs = (presentations as { templateDirs?: unknown }).templateDirs;
  if (!Array.isArray(dirs)) return [];
  return dirs.filter((d): d is string => typeof d === "string" && d.length > 0);
}

function PresentationTemplateDirs({
  templateDirs,
  onSaveSetting,
}: {
  readonly templateDirs: readonly string[];
  readonly onSaveSetting: (key: string, value: unknown) => void;
}) {
  const [draft, setDraft] = useState("");
  const save = (next: readonly string[]) => onSaveSetting("presentations.templateDirs", next);
  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (templateDirs.includes(trimmed)) { setDraft(""); return; }
    save([...templateDirs, trimmed]);
    setDraft("");
  };
  const remove = (dir: string) => save(templateDirs.filter((d) => d !== dir));
  return (
    <section aria-label="Presentation template directories">
      <h3>Presentation templates</h3>
      <p>Paths listed here are scanned by <code>core.presentations</code> for template packs. Each pack directory must contain a <code>pack.json</code> manifest and a <code>render.mjs</code> entry.</p>
      <ul>
        {templateDirs.length === 0 ? <li><em>No template directories configured.</em></li> : null}
        {templateDirs.map((dir) => (
          <li key={dir}>
            <code>{dir}</code>{" "}
            <button type="button" onClick={() => remove(dir)} aria-label={`Remove ${dir}`}>Remove</button>
          </li>
        ))}
      </ul>
      <input
        aria-label="New template directory"
        placeholder="/path/to/templates"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
      />
      <button type="button" onClick={add}>Add directory</button>
    </section>
  );
}

export function ConfigurationPanel(props: ConfigurationPanelProps) {
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [settingKey, setSettingKey] = useState("defaultModel");
  const [settingValue, setSettingValue] = useState("");
  const [packageSource, setPackageSource] = useState("npm:pi-package");

  return (
    <section className="configuration-panel" aria-label="Configuration">
      <h2>Configuration</h2>

      <section aria-label="Auth panel">
        <h3>Auth</h3>
        {props.authProviders.map((auth) => (
          <div key={auth.provider}>
            <strong>{auth.provider}</strong> <span>{auth.status}</span>
            {auth.warning ? <p role="alert">{auth.warning}</p> : null}
            <button type="button" onClick={() => props.onLogin(auth.provider)}>Login</button>
            <button type="button" onClick={() => props.onLogout(auth.provider)}>Logout</button>
            <input aria-label={`${auth.provider} API key`} value={apiKeys[auth.provider] ?? ""} onChange={(event) => setApiKeys((current) => ({ ...current, [auth.provider]: event.target.value }))} />
            <button type="button" onClick={() => props.onApiKey(auth.provider, apiKeys[auth.provider] ?? "")}>Save API key</button>
          </div>
        ))}
      </section>

      <section aria-label="Model selector">
        <h3>Models</h3>
        {props.models.map((model) => (
          <button key={`${model.provider}/${model.id}`} type="button" disabled={!model.available} onClick={() => props.onModelSelect(model.provider, model.id)}>
            {model.name} {model.available ? "" : `(${model.reason ?? "unavailable"})`}
          </button>
        ))}
      </section>

      <section aria-label="Thinking selector">
        <h3>Thinking</h3>
        {['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((level) => (
          <button key={level} type="button" aria-pressed={props.thinkingLevel === level} onClick={() => props.onThinkingSelect(level)}>{level}</button>
        ))}
      </section>

      <section aria-label="Active tools">
        <h3>Tools</h3>
        {props.tools.map((tool) => (
          <label key={tool.name}>
            <input type="checkbox" checked={tool.enabled} onChange={(event) => props.onToolToggle(tool.name, event.target.checked)} />
            {tool.name} ({tool.source})
          </label>
        ))}
      </section>

      <section aria-label="Settings panel">
        <h3>Settings</h3>
        <pre>{JSON.stringify(props.settings, null, 2)}</pre>
        <input aria-label="Setting key" value={settingKey} onChange={(event) => setSettingKey(event.target.value)} />
        <input aria-label="Setting value" value={settingValue} onChange={(event) => setSettingValue(event.target.value)} />
        <button type="button" onClick={() => props.onSaveSetting(settingKey, settingValue)}>Save setting</button>
      </section>

      <PresentationTemplateDirs
        templateDirs={getTemplateDirs(props.settings)}
        onSaveSetting={props.onSaveSetting}
      />

      <section aria-label="Theme management">
        <h3>Themes</h3>
        {props.themes.map((theme) => <button key={theme.name} type="button" onClick={() => props.onThemeSelect(theme.name)}>{theme.name}</button>)}
      </section>

      <section aria-label="Resource diagnostics">
        <h3>Resources</h3>
        <button type="button" onClick={props.onReloadResources}>Reload resources</button>
        {props.resources.map((resource) => <p key={`${resource.kind}:${resource.name}`}>{resource.kind}: {resource.name} - {resource.status} {resource.detail}</p>)}
      </section>

      <section aria-label="Extension management">
        <h3>Extensions</h3>
        <button type="button" onClick={() => props.onExtensionsReload?.()}>Reload extensions</button>
        {(props.extensions ?? []).length === 0 ? <p>No extensions loaded.</p> : null}
        {(props.extensions ?? []).map((extension) => (
          <label key={extension.id}>
            <input
              type="checkbox"
              checked={extension.enabled}
              onChange={(event) => props.onExtensionToggle?.(extension.id, event.target.checked)}
            />
            {extension.title ?? extension.id} ({extension.source})
            {extension.diagnostics?.length ? <span role="alert"> {extension.diagnostics.join("; ")}</span> : null}
          </label>
        ))}
      </section>

      <section aria-label="Package management">
        <h3>Packages</h3>
        <input aria-label="Package source" value={packageSource} onChange={(event) => setPackageSource(event.target.value)} />
        <button type="button" onClick={() => props.onPackageInstall(packageSource)}>Install package</button>
        {props.packages.map((pkg) => <p key={pkg.source}>{pkg.source} <button type="button" onClick={() => props.onPackageRemove(pkg.source)}>Remove package</button></p>)}
      </section>

      <section aria-label="Hotkeys"><h3>Hotkeys</h3>{props.hotkeys.map((hotkey) => <p key={hotkey.action}>{hotkey.action}: {hotkey.key}</p>)}</section>
      <section aria-label="Changelog and versions"><h3>Versions</h3>{props.versions.map((version) => <p key={version.name}>{version.name}: {version.version}</p>)}</section>
    </section>
  );
}
