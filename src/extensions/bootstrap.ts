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

export async function bootstrapPrcExtensions(options: BootstrapPrcExtensionsOptions): Promise<BootstrapPrcExtensionsResult> {
  const host = createPrcExtensionHost({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
  });
  const env = options.env ?? process.env;
  if (options.noExtensions || env.PI_REMOTE_NO_EXTENSIONS === "1") return { host, diagnostics: [] };

  const packageDiagnostics: PackageDiagnostic[] = [];
  const explicitPaths = [...(options.explicitExtensionPaths ?? []), ...parseExtensionEnv(env.PI_REMOTE_EXTENSIONS)];
  const explicitInputs = await loadExplicitExtensionInputs(explicitPaths, options.cwd, packageDiagnostics);

  const settings = await readPrcSettings(options.configDir);
  const projectDiscovered = await discoverPackages(path.join(options.cwd, ".pi", "remote-control", "extensions"));
  const globalDiscovered = await discoverPackages(path.join(options.configDir, "extensions"));
  const project = await resolvePackageExtensions(settings.projectPackages || projectDiscovered.length ? { projectPackages: [...(settings.projectPackages ?? []), ...projectDiscovered] } : {}, { cwd: options.cwd });
  const global = await resolvePackageExtensions(settings.packages || globalDiscovered.length ? { packages: [...(settings.packages ?? []), ...globalDiscovered] } : {}, { cwd: options.configDir });
  const bundled = await resolvePackageExtensions(options.bundledPackagePaths?.length ? { packages: options.bundledPackagePaths } : {}, { cwd: options.cwd });
  packageDiagnostics.push(...project.diagnostics, ...global.diagnostics, ...bundled.diagnostics);

  await registerWebAssets(host, project.webExtensions, packageDiagnostics);
  await registerWebAssets(host, global.webExtensions, packageDiagnostics);
  await registerWebAssets(host, bundled.webExtensions, packageDiagnostics);
  const projectInputs = await loadEntriesAsInputs(project.extensions, packageDiagnostics);
  const globalInputs = await loadEntriesAsInputs(global.extensions, packageDiagnostics);
  const bundledInputs = await loadEntriesAsInputs(bundled.extensions, packageDiagnostics);
  const builtInInputs = (options.builtIns ?? []).map((extension): ActivateExtensionInput => ({ id: extension.id, factory: extension.factory }));

  await host.activateAll([...explicitInputs, ...projectInputs, ...globalInputs, ...bundledInputs, ...builtInInputs]);
  for (const diagnostic of packageDiagnostics) {
    host.diagnostics.push({ extensionId: diagnostic.source, level: diagnostic.level, message: diagnostic.message });
  }
  return { host, diagnostics: packageDiagnostics };
}

export function defaultPrcConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.PI_REMOTE_CONFIG_DIR ?? path.join(env.HOME ?? process.cwd(), ".pi-remote-control"));
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

async function loadExplicitExtensionInputs(paths: readonly string[], cwd: string, diagnostics: PackageDiagnostic[]): Promise<ActivateExtensionInput[]> {
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
  return loadEntriesAsInputs(entries, diagnostics, inferExplicitExtensionId);
}

async function loadEntriesAsInputs(
  entries: readonly ResolvedExtensionEntry[],
  diagnostics: PackageDiagnostic[],
  inferId: (filePath: string, entry: ResolvedExtensionEntry) => string | Promise<string> = defaultExtensionId,
): Promise<ActivateExtensionInput[]> {
  const inputs: ActivateExtensionInput[] = [];
  for (const entry of entries) {
    try {
      inputs.push({ id: await inferId(entry.path, entry), factory: await loadPrcExtensionFactory(entry.path) });
    } catch (error) {
      diagnostics.push({ source: entry.path, level: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return inputs;
}

async function defaultExtensionId(_filePath: string, entry: ResolvedExtensionEntry): Promise<string> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(entry.packageSource, "package.json"), "utf8")) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name;
  } catch { /* fall back */ }
  return path.basename(entry.packageSource) || inferExplicitExtensionId(entry.path);
}

async function registerWebAssets(host: PrcExtensionHost, entries: readonly ResolvedWebExtensionEntry[], diagnostics: PackageDiagnostic[]): Promise<void> {
  for (const entry of entries) {
    try {
      host.registerWebAsset(await defaultWebExtensionId(entry), entry.path);
    } catch (error) {
      diagnostics.push({ source: entry.path, level: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
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
