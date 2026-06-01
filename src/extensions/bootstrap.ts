import fs from "node:fs/promises";
import path from "node:path";
import type { PrcExtensionFactory, PrcSessionsApi } from "./api.js";
import { loadPrcExtensionFactory } from "./loader.js";
import {
  readPrcSettings,
  resolvePackageExtensions,
  resolveSinglePackageExtensions,
  type PackageDiagnostic,
  type ResolvedExtensionEntry,
  type ResolvedWebExtensionEntry,
} from "./packages.js";
import { createPrcExtensionHost, type ActivateExtensionInput, type PrcExtensionHost } from "./registry.js";

import { optional } from "../shared/util.js";
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

export interface ResolvedPrcExtensionContribution {
  readonly id: string;
  readonly packageSource: string;
  readonly scope: "global" | "project" | "explicit";
  readonly enabled: boolean;
  readonly serverEntry?: string;
  readonly webEntry?: string;
  readonly piExtensionEntries?: readonly string[];
}

export interface BootstrapPrcExtensionsResult {
  readonly host: PrcExtensionHost;
  readonly diagnostics: readonly PackageDiagnostic[];
}

export async function bootstrapPrcExtensions(options: BootstrapPrcExtensionsOptions): Promise<BootstrapPrcExtensionsResult> {
  const host = createPrcExtensionHost({
    ...optional({ dataDir: options.dataDir }),
    ...optional({ sessions: options.sessions }),
    configDir: options.configDir,
  });
  const env = options.env ?? process.env;
  if (options.noExtensions || env.PI_CRUST_NO_EXTENSIONS === "1") return { host, diagnostics: [] };

  const packageDiagnostics: PackageDiagnostic[] = [];
  const explicitPaths = [...(options.explicitExtensionPaths ?? []), ...parseExtensionEnv(env.PI_CRUST_EXTENSIONS)];

  const settings = await readPrcSettings(options.configDir);
  const disabledExtensionIds = new Set(settings.disabledExtensions ?? []);
  const projectDiscovered = await discoverPackages(path.join(options.cwd, ".pi", "remote-control", "extensions"));
  const globalDiscovered = await discoverPackages(path.join(options.configDir, "extensions"));
  const project = await resolvePackageExtensions(settings.projectPackages || projectDiscovered.length ? { projectPackages: [...(settings.projectPackages ?? []), ...projectDiscovered] } : {}, { cwd: options.cwd });
  const global = await resolvePackageExtensions(settings.packages || globalDiscovered.length ? { packages: [...(settings.packages ?? []), ...globalDiscovered] } : {}, { cwd: options.configDir });
  const bundled = await resolvePackageExtensions(options.bundledPackagePaths?.length ? { packages: options.bundledPackagePaths } : {}, { cwd: options.cwd });
  packageDiagnostics.push(...project.diagnostics, ...global.diagnostics, ...bundled.diagnostics);

  const explicitPlan = await resolveExplicitExtensionPlan(explicitPaths, options.cwd, packageDiagnostics);
  const projectPlan = await resolveExtensionContributionPlan(project.extensions, project.webExtensions, packageDiagnostics, disabledExtensionIds);
  const globalPlan = await resolveExtensionContributionPlan(global.extensions, global.webExtensions, packageDiagnostics, disabledExtensionIds);
  const bundledPlan = await resolveExtensionContributionPlan(bundled.extensions, bundled.webExtensions, packageDiagnostics, disabledExtensionIds);
  // Dedupe by extension id across all scopes. The same id can legitimately be
  // resolved from multiple sources (e.g. an official extension that ships
  // bundled AND that a user re-adds as an npm/git source). Activating both
  // copies makes the second registerView/registerRoute call throw "already
  // registered", which surfaces as an error-level diagnostic and makes EVERY
  // reload return applied:false (HTTP 400) — so the user can no longer toggle
  // or remove anything. Keep one copy per id, preferring (highest first):
  // explicit dev flags > bundled official packages > project > global user
  // sources. Dropped duplicates become non-fatal warnings.
  const contributionPlan = dedupeContributionPlanById(
    [
      { priority: 3, plan: explicitPlan },
      { priority: 1, plan: projectPlan },
      { priority: 0, plan: globalPlan },
      { priority: 2, plan: bundledPlan },
    ],
    packageDiagnostics,
  );
  host.contributionPlan = contributionPlan;
  await registerPlannedWebAssets(host, contributionPlan);
  const extensionInputs = await loadPlannedServerInputs(contributionPlan, packageDiagnostics);
  const builtInInputs = (options.builtIns ?? [])
    .filter((extension) => !disabledExtensionIds.has(extension.id))
    .map((extension): ActivateExtensionInput => ({ id: extension.id, factory: extension.factory }));

  await host.activateAll([...extensionInputs, ...builtInInputs]);
  for (const diagnostic of packageDiagnostics) {
    host.diagnostics.push({ extensionId: diagnostic.source, level: diagnostic.level, message: diagnostic.message });
  }
  return { host, diagnostics: packageDiagnostics };
}

/**
 * Collapse duplicate extension ids across scoped plans. Output preserves the
 * original concatenation order (explicit, project, global, bundled) for the
 * surviving contributions; `priority` only decides which copy wins a conflict.
 * Every dropped duplicate emits a non-fatal warning diagnostic.
 */
function dedupeContributionPlanById(
  groups: readonly { readonly priority: number; readonly plan: readonly ResolvedPrcExtensionContribution[] }[],
  diagnostics: PackageDiagnostic[],
): ResolvedPrcExtensionContribution[] {
  const winningPriority = new Map<string, number>();
  for (const { priority, plan } of groups) {
    for (const contribution of plan) {
      const current = winningPriority.get(contribution.id);
      if (current === undefined || priority > current) winningPriority.set(contribution.id, priority);
    }
  }
  // Emit in original concat order so non-duplicate behavior is unchanged.
  const order = [...groups].sort((a, b) => a.priority === b.priority ? 0 : OUTPUT_ORDER.indexOf(a.priority) - OUTPUT_ORDER.indexOf(b.priority));
  const result: ResolvedPrcExtensionContribution[] = [];
  const taken = new Set<string>();
  for (const { priority, plan } of order) {
    for (const contribution of plan) {
      const winsGroup = priority === winningPriority.get(contribution.id);
      if (winsGroup && !taken.has(contribution.id)) {
        result.push(contribution);
        taken.add(contribution.id);
      } else {
        diagnostics.push({
          source: contribution.packageSource,
          level: "warning",
          message: `Skipped duplicate extension "${contribution.id}" from ${contribution.packageSource}; it is already provided by another source.`,
        });
      }
    }
  }
  return result;
}

// Priorities in the order they should appear in the activation plan
// (explicit=3, project=1, global=0, bundled=2 -> explicit, project, global, bundled).
const OUTPUT_ORDER = [3, 1, 0, 2];

export function defaultPrcConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.PI_CRUST_CONFIG_DIR ?? path.join(env.HOME ?? process.cwd(), ".pi-crust"));
}

function parseExtensionEnv(value: string | undefined): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

async function discoverPackages(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || /\.[cm]?[jt]sx?$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function resolveExplicitExtensionPlan(paths: readonly string[], cwd: string, diagnostics: PackageDiagnostic[]): Promise<ResolvedPrcExtensionContribution[]> {
  const entries: ResolvedExtensionEntry[] = [];
  for (const extensionPath of paths) {
    const absolute = path.resolve(cwd, extensionPath);
    try {
      const resolvedPaths = await resolveSinglePackageExtensions(absolute);
      for (const resolvedPath of resolvedPaths) entries.push({ packageSource: absolute, path: resolvedPath, scope: "explicit" });
    } catch (error) {
      diagnostics.push({ source: absolute, level: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return resolveExtensionContributionPlan(entries, [], diagnostics, new Set(), inferExplicitExtensionId);
}

async function resolveExtensionContributionPlan(
  serverEntries: readonly ResolvedExtensionEntry[],
  webEntries: readonly ResolvedWebExtensionEntry[],
  diagnostics: PackageDiagnostic[],
  disabledExtensionIds: ReadonlySet<string>,
  inferId: (filePath: string, entry: ResolvedExtensionEntry) => string | Promise<string> = defaultExtensionId,
): Promise<ResolvedPrcExtensionContribution[]> {
  const plan = new Map<string, ResolvedPrcExtensionContribution>();
  const piExtensionEntriesByPackage = new Map<string, readonly string[]>();
  const getPiExtensionEntries = async (packageSource: string): Promise<readonly string[]> => {
    if (!piExtensionEntriesByPackage.has(packageSource)) {
      piExtensionEntriesByPackage.set(packageSource, await readPackagePiExtensionEntries(packageSource));
    }
    return piExtensionEntriesByPackage.get(packageSource)!;
  };
  const update = async (id: string, packageSource: string, scope: ResolvedPrcExtensionContribution["scope"], patch: Partial<Pick<ResolvedPrcExtensionContribution, "serverEntry" | "webEntry">>) => {
    const key = `${scope}:${packageSource}:${id}`;
    const current = plan.get(key) ?? { id, packageSource, scope, enabled: !disabledExtensionIds.has(id) };
    const piExtensionEntries = await getPiExtensionEntries(packageSource);
    plan.set(key, { ...current, ...patch, ...(piExtensionEntries.length === 0 ? {} : { piExtensionEntries }) });
  };
  for (const entry of serverEntries) {
    try {
      await update(await inferId(entry.path, entry), entry.packageSource, entry.scope, { serverEntry: entry.path });
    } catch (error) {
      diagnostics.push({ source: entry.path, level: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const entry of webEntries) {
    try {
      await update(await defaultWebExtensionId(entry), entry.packageSource, entry.scope, { webEntry: entry.path });
    } catch (error) {
      diagnostics.push({ source: entry.path, level: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return [...plan.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
}

async function loadPlannedServerInputs(plan: readonly ResolvedPrcExtensionContribution[], diagnostics: PackageDiagnostic[]): Promise<ActivateExtensionInput[]> {
  const inputs: ActivateExtensionInput[] = [];
  for (const contribution of plan) {
    if (!contribution.enabled || !contribution.serverEntry) continue;
    try {
      inputs.push({ id: contribution.id, factory: await loadPrcExtensionFactory(contribution.serverEntry) });
    } catch (error) {
      diagnostics.push({ source: contribution.serverEntry, level: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return inputs;
}

async function registerPlannedWebAssets(host: PrcExtensionHost, plan: readonly ResolvedPrcExtensionContribution[]): Promise<void> {
  for (const contribution of plan) {
    if (contribution.enabled && contribution.webEntry) host.registerWebAsset(contribution.id, contribution.webEntry);
  }
}

async function readPackagePiExtensionEntries(packageSource: string): Promise<readonly string[]> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(packageSource, "package.json"), "utf8")) as { pi?: unknown };
    const pi = manifest.pi;
    if (typeof pi === "object" && pi !== null && "extensions" in pi && Array.isArray((pi as { extensions?: unknown }).extensions)) {
      const extensions = (pi as { extensions: unknown[] }).extensions;
      return extensions.every((entry) => typeof entry === "string") ? extensions as string[] : [];
    }
  } catch { /* no pi-side extension entries */ }
  return [];
}

async function defaultExtensionId(_filePath: string, entry: ResolvedExtensionEntry): Promise<string> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(entry.packageSource, "package.json"), "utf8")) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name;
  } catch { /* fall back */ }
  return path.basename(entry.packageSource) || inferExplicitExtensionId(entry.path);
}

async function defaultWebExtensionId(entry: ResolvedWebExtensionEntry): Promise<string> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(entry.packageSource, "package.json"), "utf8")) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name;
  } catch { /* fall back */ }
  return path.basename(entry.packageSource) || inferExplicitExtensionId(entry.path);
}

function inferExplicitExtensionId(filePath: string): string {
  return `explicit:${path.basename(filePath, path.extname(filePath))}`;
}
