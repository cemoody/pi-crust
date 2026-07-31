import path from "node:path";
import type { PrcExtensionFactory, PrcSessionsApi } from "./api.js";
import { createPrcExtensionHost, type PrcExtensionHost } from "./registry.js";
import type { PackageDiagnostic } from "./packages.js";
import {
  createExtensionContributionPlan,
  loadContributionServerInputs,
  type ResolvedPrcExtensionContribution,
} from "./lifecycle/extension-contribution-plan.js";
import { optional } from "../shared/util.js";

export type { ResolvedPrcExtensionContribution } from "./lifecycle/extension-contribution-plan.js";

export interface BuiltInPrcExtension {
  readonly id: string;
  readonly factory: PrcExtensionFactory;
}

export interface BootstrapPrcExtensionsOptions {
  readonly configDir: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly builtIns?: readonly BuiltInPrcExtension[];
  /** Bundled package directories loaded by default through the same package resolver as installed extensions. */
  readonly bundledPackagePaths?: readonly string[];
  readonly explicitExtensionPaths?: readonly string[];
  readonly noExtensions?: boolean;
  readonly dataDir?: string;
  readonly sessions?: PrcSessionsApi;
}

export interface BootstrapPrcExtensionsResult {
  readonly host: PrcExtensionHost;
  readonly diagnostics: readonly PackageDiagnostic[];
}

/**
 * Compose the package-source lifecycle with the extension host lifecycle.
 * Source resolution and precedence live behind the contribution-plan boundary;
 * this module owns only host construction, activation, and legacy API shape.
 */
export async function bootstrapPrcExtensions(options: BootstrapPrcExtensionsOptions): Promise<BootstrapPrcExtensionsResult> {
  const host = createPrcExtensionHost({
    ...optional({ dataDir: options.dataDir }),
    ...optional({ sessions: options.sessions }),
    configDir: options.configDir,
  });
  const env = options.env ?? process.env;
  if (options.noExtensions || env.PI_CRUST_NO_EXTENSIONS === "1") return { host, diagnostics: [] };

  const contribution = await createExtensionContributionPlan({
    configDir: options.configDir,
    cwd: options.cwd,
    env,
    ...optional({ bundledPackagePaths: options.bundledPackagePaths }),
    ...optional({ explicitExtensionPaths: options.explicitExtensionPaths }),
  });
  host.contributionPlan = contribution.plan;
  registerPlannedWebAssets(host, contribution.plan);
  const extensionInputs = await loadContributionServerInputs(contribution.plan, contribution.diagnostics);
  const builtInInputs = (options.builtIns ?? [])
    .filter((extension) => !contribution.disabledExtensionIds.has(extension.id))
    .map((extension) => ({ id: extension.id, factory: extension.factory }));
  await host.activateAll([...extensionInputs, ...builtInInputs]);
  for (const diagnostic of contribution.diagnostics) {
    host.diagnostics.push({ extensionId: diagnostic.source, level: diagnostic.level, message: diagnostic.message });
  }
  return { host, diagnostics: contribution.diagnostics };
}

export function defaultPrcConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.PI_CRUST_CONFIG_DIR ?? path.join(env.HOME ?? process.cwd(), ".pi-crust"));
}

function registerPlannedWebAssets(host: PrcExtensionHost, plan: readonly ResolvedPrcExtensionContribution[]): void {
  for (const contribution of plan) {
    if (contribution.enabled && contribution.webEntry) host.registerWebAsset(contribution.id, contribution.webEntry);
  }
}
