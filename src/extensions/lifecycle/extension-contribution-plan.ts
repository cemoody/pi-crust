import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/util.js";
import type { ActivateExtensionInput } from "../registry.js";
import { inferPrcExtensionId, loadPrcExtensionFactory } from "../loader.js";
import {
  readPrcSettings,
  resolvePackageExtensions,
  resolveSinglePackageExtensions,
  type PackageDiagnostic,
  type ResolvedExtensionEntry,
  type ResolvedWebExtensionEntry,
} from "../packages.js";

export interface ExtensionContributionPlanOptions {
  readonly configDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly bundledPackagePaths?: readonly string[];
  readonly explicitExtensionPaths?: readonly string[];
}

/**
 * A source-independent extension activation contract. Package discovery owns
 * source precedence; the host only consumes this plan to register assets and
 * activate server factories.
 */
export interface ResolvedPrcExtensionContribution {
  readonly id: string;
  readonly packageSource: string;
  readonly scope: "global" | "project" | "explicit";
  readonly enabled: boolean;
  readonly serverEntry?: string;
  readonly webEntry?: string;
  readonly piExtensionEntries?: readonly string[];
}

export interface ExtensionContributionPlanResult {
  readonly plan: readonly ResolvedPrcExtensionContribution[];
  readonly diagnostics: PackageDiagnostic[];
  /** Includes disabled ids with no package contribution so built-ins honor settings too. */
  readonly disabledExtensionIds: ReadonlySet<string>;
}

/** Resolve installed, discovered, bundled, and explicit package sources into one activation plan. */
export async function createExtensionContributionPlan(options: ExtensionContributionPlanOptions): Promise<ExtensionContributionPlanResult> {
  const diagnostics: PackageDiagnostic[] = [];
  const explicitPaths = [...(options.explicitExtensionPaths ?? []), ...parseExtensionEnv(options.env.PI_CRUST_EXTENSIONS)];
  const settings = await readPrcSettings(options.configDir);
  const disabledExtensionIds = new Set(settings.disabledExtensions ?? []);
  const projectDiscovered = await discoverPackages(path.join(options.cwd, ".pi", "remote-control", "extensions"));
  const globalDiscovered = await discoverPackages(path.join(options.configDir, "extensions"));
  const project = await resolvePackageExtensions(settings.projectPackages || projectDiscovered.length
    ? { projectPackages: [...(settings.projectPackages ?? []), ...projectDiscovered] }
    : {}, { cwd: options.cwd });
  const global = await resolvePackageExtensions(settings.packages || globalDiscovered.length
    ? { packages: [...(settings.packages ?? []), ...globalDiscovered] }
    : {}, { cwd: options.configDir });
  const bundled = await resolvePackageExtensions(options.bundledPackagePaths?.length
    ? { packages: options.bundledPackagePaths }
    : {}, { cwd: options.cwd });
  diagnostics.push(...project.diagnostics, ...global.diagnostics, ...bundled.diagnostics);

  const explicitPlan = await resolveExplicitExtensionPlan(explicitPaths, options.cwd, diagnostics);
  const projectPlan = await resolveExtensionContributionPlan(project.extensions, project.webExtensions, diagnostics, disabledExtensionIds);
  const globalPlan = await resolveExtensionContributionPlan(global.extensions, global.webExtensions, diagnostics, disabledExtensionIds);
  const bundledPlan = await resolveExtensionContributionPlan(bundled.extensions, bundled.webExtensions, diagnostics, disabledExtensionIds);
  return {
    plan: dedupeContributionPlanById([
      { priority: 3, plan: explicitPlan },
      { priority: 1, plan: projectPlan },
      { priority: 0, plan: globalPlan },
      { priority: 2, plan: bundledPlan },
    ], diagnostics),
    diagnostics,
    disabledExtensionIds,
  };
}

/** Load only enabled server contributions. Loading failures join the plan diagnostics. */
export async function loadContributionServerInputs(
  plan: readonly ResolvedPrcExtensionContribution[],
  diagnostics: PackageDiagnostic[],
): Promise<ActivateExtensionInput[]> {
  const inputs: ActivateExtensionInput[] = [];
  for (const contribution of plan) {
    if (!contribution.enabled || !contribution.serverEntry) continue;
    try {
      inputs.push({ id: contribution.id, factory: await loadPrcExtensionFactory(contribution.serverEntry) });
    } catch (error) {
      diagnostics.push({ source: contribution.serverEntry, level: "error", message: errorMessage(error) });
    }
  }
  return inputs;
}

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
  const result: ResolvedPrcExtensionContribution[] = [];
  const taken = new Set<string>();
  for (const { priority, plan } of [...groups].sort((a, b) => OUTPUT_ORDER.indexOf(a.priority) - OUTPUT_ORDER.indexOf(b.priority))) {
    for (const contribution of plan) {
      if (priority === winningPriority.get(contribution.id) && !taken.has(contribution.id)) {
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

const OUTPUT_ORDER = [3, 1, 0, 2];

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

function parseExtensionEnv(value: string | undefined): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

async function resolveExplicitExtensionPlan(paths: readonly string[], cwd: string, diagnostics: PackageDiagnostic[]): Promise<ResolvedPrcExtensionContribution[]> {
  const entries: ResolvedExtensionEntry[] = [];
  for (const extensionPath of paths) {
    const absolute = path.resolve(cwd, extensionPath);
    try {
      for (const resolvedPath of await resolveSinglePackageExtensions(absolute)) {
        entries.push({ packageSource: absolute, path: resolvedPath, scope: "explicit" });
      }
    } catch (error) {
      diagnostics.push({ source: absolute, level: "error", message: errorMessage(error) });
    }
  }
  return resolveExtensionContributionPlan(entries, [], diagnostics, new Set(), (filePath) => `explicit:${path.basename(filePath, path.extname(filePath))}`);
}

async function resolveExtensionContributionPlan(
  serverEntries: readonly ResolvedExtensionEntry[],
  webEntries: readonly ResolvedWebExtensionEntry[],
  diagnostics: PackageDiagnostic[],
  disabledExtensionIds: ReadonlySet<string>,
  inferId: (filePath: string, entry: ResolvedExtensionEntry) => string | Promise<string> = (filePath, entry) => inferPrcExtensionId(entry.packageSource, filePath),
): Promise<ResolvedPrcExtensionContribution[]> {
  const plan = new Map<string, ResolvedPrcExtensionContribution>();
  const piEntriesByPackage = new Map<string, readonly string[]>();
  const readPiEntries = async (packageSource: string): Promise<readonly string[]> => {
    if (!piEntriesByPackage.has(packageSource)) piEntriesByPackage.set(packageSource, await readPackagePiExtensionEntries(packageSource));
    return piEntriesByPackage.get(packageSource)!;
  };
  const update = async (id: string, packageSource: string, scope: ResolvedPrcExtensionContribution["scope"], patch: Partial<Pick<ResolvedPrcExtensionContribution, "serverEntry" | "webEntry">>) => {
    const key = `${scope}:${packageSource}:${id}`;
    const current = plan.get(key) ?? { id, packageSource, scope, enabled: !disabledExtensionIds.has(id) };
    const piExtensionEntries = await readPiEntries(packageSource);
    plan.set(key, { ...current, ...patch, ...(piExtensionEntries.length === 0 ? {} : { piExtensionEntries }) });
  };
  for (const entry of serverEntries) {
    try { await update(await inferId(entry.path, entry), entry.packageSource, entry.scope, { serverEntry: entry.path }); }
    catch (error) { diagnostics.push({ source: entry.path, level: "error", message: errorMessage(error) }); }
  }
  for (const entry of webEntries) {
    try { await update(await inferPrcExtensionId(entry.packageSource, entry.path), entry.packageSource, entry.scope, { webEntry: entry.path }); }
    catch (error) { diagnostics.push({ source: entry.path, level: "error", message: errorMessage(error) }); }
  }
  return [...plan.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
}

async function readPackagePiExtensionEntries(packageSource: string): Promise<readonly string[]> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(packageSource, "package.json"), "utf8")) as { pi?: unknown };
    const pi = manifest.pi;
    if (typeof pi === "object" && pi !== null && "extensions" in pi && Array.isArray((pi as { extensions?: unknown }).extensions)) {
      const extensions = (pi as { extensions: unknown[] }).extensions;
      return extensions.every((entry) => typeof entry === "string") ? extensions as string[] : [];
    }
  } catch { /* packages without Pi-side entries are valid */ }
  return [];
}
