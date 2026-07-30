import * as React from "react";
import { type ReactNode } from "react";
import type {
  ExtensionRegistryInfo,
  ExtensionSettingsSectionInfo,
  SessionDashboardApi,
} from "../api/session-api.js";
import { useExternalWebModule } from "./use-external-web-module.js";

export interface ExternalWebSettingsSectionProps {
  readonly section: ExtensionSettingsSectionInfo;
  readonly extensions: ExtensionRegistryInfo;
  readonly api: SessionDashboardApi;
  /** React is supplied by the host so external modules can be plain ESM without bundling React. */
  readonly React?: typeof React;
}

export type ExternalWebSettingsSectionComponent = (
  props: ExternalWebSettingsSectionProps,
) => ReactNode;

export interface ExternalWebSettingsSectionModule {
  readonly default?: ExternalWebSettingsSectionComponent;
  readonly renderSettingsSection?: ExternalWebSettingsSectionComponent;
}

const getSettingsSectionComponent = (module: ExternalWebSettingsSectionModule) => module.renderSettingsSection ?? module.default;

export function ExternalWebSettingsSection(props: ExternalWebSettingsSectionProps) {
  const state = useExternalWebModule(
    props.section.webModuleUrl,
    getSettingsSectionComponent,
    `Web module for ${props.section.id} does not export a renderer.`,
  );

  if (!props.section.webModuleUrl) {
    return (
      <div className="extension-web-placeholder" role="note">
        No settings UI provided by <code>{props.section.extensionId}</code>.
      </div>
    );
  }
  if (state.error) return <div role="alert" className="extension-web-error">Extension settings module failed: {state.error}</div>;
  if (!state.component) return <div role="status" className="extension-web-loading">Loading extension settings…</div>;
  const Component = state.component;
  return <>{Component({ ...props, React })}</>;
}
