import { useEffect, useState } from "react";
import { errorMessage } from "../../shared/util.js";

export interface ExternalWebModuleState<Component> {
  readonly component?: Component;
  readonly error?: string;
}

/**
 * Dynamically loads an extension's optional web renderer while preventing a
 * completed import from updating a component that has since been replaced.
 */
export function useExternalWebModule<Component, Module extends { readonly default?: Component }>(
  webModuleUrl: string | undefined,
  getComponent: (module: Module) => Component | undefined,
  missingComponentError: string,
): ExternalWebModuleState<Component> {
  const [state, setState] = useState<ExternalWebModuleState<Component>>({});

  useEffect(() => {
    let cancelled = false;
    setState({});
    if (!webModuleUrl) return;

    void import(/* @vite-ignore */ webModuleUrl)
      .then((module: Module) => {
        if (cancelled) return;
        const component = getComponent(module);
        setState(component ? { component } : { error: missingComponentError });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ error: errorMessage(error) });
      });

    return () => { cancelled = true; };
  }, [getComponent, missingComponentError, webModuleUrl]);

  return state;
}
