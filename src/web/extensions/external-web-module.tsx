import * as React from "react";
import { type ReactNode } from "react";
import type { ExtensionActivityInfo, ExtensionRegistryInfo, SessionDashboardApi } from "../api/session-api.js";
import { useExternalWebModule } from "./use-external-web-module.js";

export interface ExternalWebActivityNavigation {
  openSession(sessionId: string): void | Promise<void>;
}

export interface ExternalWebActivityProps {
  readonly activity: ExtensionActivityInfo;
  readonly extensions: ExtensionRegistryInfo;
  readonly api: SessionDashboardApi;
  readonly navigation?: ExternalWebActivityNavigation;
  /** React is supplied by the host so external modules can be plain ESM without bundling React. */
  readonly React?: typeof React;
}

export type ExternalWebActivityComponent = (props: ExternalWebActivityProps) => ReactNode;

export interface ExternalWebActivityModule {
  readonly default?: ExternalWebActivityComponent;
  readonly renderActivity?: ExternalWebActivityComponent;
}

const getActivityComponent = (module: ExternalWebActivityModule) => module.renderActivity ?? module.default;

export function ExternalWebActivity(props: ExternalWebActivityProps) {
  const state = useExternalWebModule(
    props.activity.webModuleUrl,
    getActivityComponent,
    `Web module for ${props.activity.id} does not export a renderer.`,
  );

  if (!props.activity.webModuleUrl) return null;
  if (state.error) return <div role="alert" className="extension-web-error">Extension web module failed: {state.error}</div>;
  if (!state.component) return <div role="status" className="extension-web-loading">Loading extension UI…</div>;
  const Component = state.component;
  return <>{Component({ ...props, React })}</>;
}
