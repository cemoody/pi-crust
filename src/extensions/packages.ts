import fs from "node:fs/promises";
import path from "node:path";

export interface PrcSettings {
  readonly packages?: readonly PrcPackageSetting[];
  readonly projectPackages?: readonly PrcPackageSetting[];
  readonly disabledExtensions?: readonly string[];
  readonly appBranding?: PrcAppBrandingSettings;
  /** Configuration block consumed by the core.presentations extension. */
  readonly presentations?: PrcPresentationsSettings;
}

export interface PrcPresentationsSettings {
  /** Absolute or ~-prefixed paths to template-pack directories that the presentations extension should scan on activation. */
  readonly templateDirs?: readonly string[];
}

export interface PrcAppBrandingSettings {
  readonly appName?: string;
  /** Image URL/data URL used for the app icon. Text/emoji glyphs are intentionally not supported here. */
  readonly appIconUrl?: string;
}

export type PrcPackageSetting = string | {
  /** Original user-supplied source, e.g. npm:pkg@1.0.0, git:url@ref, or a local path. */
  readonly source: string;
  /** Managed install location for remote packages. Local packages usually omit this. */
  readonly installedPath?: string;
  readonly kind?: "local" | "npm" | "git";
  readonly extensions?: readonly string[];
};

export interface PackageCommandRunner {
  (command: string, args: readonly string[], options: { readonly cwd: string }): Promise<void>;
}

export interface PackageInstallOptions {
  readonly configDir: string;
  readonly cwd?: string;
  /** Store paths relative to configDir when possible. Defaults to true. */
  readonly relative?: boolean;
  readonly runner?: PackageCommandRunner;
}

export type ParsedPackageSource =
  | { readonly type: "local"; readonly source: string }
  | { readonly type: "npm"; readonly spec: string; readonly packageName: string }
  | { readonly type: "git"; readonly url: string; readonly ref?: string };

export interface PackageResolveOptions {
  readonly cwd: string;
  readonly noExtensions?: boolean;
}

export interface ResolvedExtensionEntry {
  readonly packageSource: string;
  readonly path: string;
  readonly scope: "global" | "project" | "explicit";
}

export interface ResolvedWebExtensionEntry {
  readonly packageSource: string;
  readonly path: string;
  readonly scope: "global" | "project" | "explicit";
}

export interface PackageDiagnostic {
  readonly source: string;
  readonly level: "error" | "warning";
  readonly message: string;
}

export interface ResolvedPackageExtensions {
  readonly extensions: readonly ResolvedExtensionEntry[];
  readonly webExtensions: readonly ResolvedWebExtensionEntry[];
  readonly diagnostics: readonly PackageDiagnostic[];
}

const SETTINGS_FILE = "settings.json";
const EXTENSION_FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);

export async function readPrcSettings(configDir: string): Promise<PrcSettings> {
  try {
    const raw = await fs.readFile(path.join(configDir, SETTINGS_FILE), "utf8");
    return JSON.parse(raw) as PrcSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writePrcSettings(configDir: string, settings: PrcSettings): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function setExtensionEnabled(configDir: string, extensionId: string, enabled: boolean): Promise<PrcSettings> {
  const settings = await readPrcSettings(configDir);
  const disabled = new Set(settings.disabledExtensions ?? []);
  if (enabled) disabled.delete(extensionId);
  else disabled.add(extensionId);
  const nextDisabled = [...disabled].sort();
  const next: PrcSettings = { ...settings, disabledExtensions: nextDisabled };
  await writePrcSettings(configDir, next);
  return next;
}

export async function installExtensionPackage(source: string, options: PackageInstallOptions): Promise<PrcSettings> {
  const cwd = options.cwd ?? process.cwd();
  const parsed = parsePackageSource(source);
  const absoluteSource = parsed.type === "local"
    ? path.resolve(cwd, parsed.source)
    : await installRemotePackageSource(parsed, options);
  if (parsed.type === "local") await assertPackageSourceExists(absoluteSource);
  const settings = await readPrcSettings(options.configDir);
  const storedSource = options.relative === false ? absoluteSource : relativeOrAbsolute(options.configDir, absoluteSource);
  const storedEntry: PrcPackageSetting = parsed.type === "local"
    ? storedSource
    : { source, installedPath: storedSource, kind: parsed.type };
  const existing = [...(settings.packages ?? [])];
  if (!existing.some((entry) => packageSettingMatches(entry, source, absoluteSource, options.configDir))) {
    existing.push(storedEntry);
  }
  const next: PrcSettings = { ...settings, packages: existing };
  await writePrcSettings(options.configDir, next);
  return next;
}

export function parsePackageSource(source: string): ParsedPackageSource {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length);
    return { type: "npm", spec, packageName: npmPackageName(spec) };
  }
  if (source.startsWith("git:")) {
    const value = source.slice("git:".length);
    const at = value.lastIndexOf("@");
    if (at > value.indexOf("/")) return { type: "git", url: value.slice(0, at), ref: value.slice(at + 1) };
    return { type: "git", url: value };
  }
  if (/^https:\/\/github\.com\/.+\/.+/.test(source) || /^git@github\.com:.+\/.+/.test(source)) return { type: "git", url: source };
  return { type: "local", source };
}

async function installRemotePackageSource(parsed: Exclude<ParsedPackageSource, { type: "local" }>, options: PackageInstallOptions): Promise<string> {
  const runner = options.runner ?? defaultPackageRunner;
  if (parsed.type === "npm") {
    const prefix = path.join(options.configDir, "packages", "npm");
    await fs.mkdir(prefix, { recursive: true });
    await runner("npm", ["install", "--prefix", prefix, parsed.spec], { cwd: options.configDir });
    return path.join(prefix, "node_modules", parsed.packageName);
  }
  const target = path.join(options.configDir, "packages", "git", safePackageDirName(parsed.url));
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.stat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await runner("git", ["clone", parsed.url, target], { cwd: options.configDir });
  }
  if (parsed.ref) await runner("git", ["checkout", parsed.ref], { cwd: target });
  return target;
}

async function defaultPackageRunner(command: string, args: readonly string[], options: { readonly cwd: string }): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function npmPackageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("@").slice(0, 2).join("@");
  return spec.split("@")[0] ?? spec;
}

function safePackageDirName(source: string): string {
  return source.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "repo";
}

function removeTargetPaths(source: string, configDir: string, cwd: string): Set<string> {
  const parsed = parsePackageSource(source);
  if (parsed.type === "npm") return new Set([path.join(configDir, "packages", "npm", "node_modules", parsed.packageName)]);
  if (parsed.type === "git") return new Set([path.join(configDir, "packages", "git", safePackageDirName(parsed.url))]);
  return new Set([path.resolve(cwd, parsed.source)]);
}

export async function removeExtensionPackage(source: string, options: PackageInstallOptions): Promise<PrcSettings> {
  const cwd = options.cwd ?? options.configDir;
  const removeTargets = removeTargetPaths(source, options.configDir, cwd);
  const settings = await readPrcSettings(options.configDir);
  const normalizedSource = normalizeSettingPath(source);
  const nextPackages = [...(settings.packages ?? [])].filter((entry) => {
    const stored = packageSettingSource(entry);
    const installed = packageSettingInstallPath(entry);
    const installedAbsolute = path.resolve(options.configDir, installed);
    return normalizeSettingPath(stored) !== normalizedSource && !removeTargets.has(installedAbsolute);
  });
  const next: PrcSettings = { ...settings, packages: nextPackages };
  await writePrcSettings(options.configDir, next);
  return next;
}

export async function resolvePackageExtensions(settings: PrcSettings, options: PackageResolveOptions): Promise<ResolvedPackageExtensions> {
  if (options.noExtensions) return { extensions: [], webExtensions: [], diagnostics: [] };
  const diagnostics: PackageDiagnostic[] = [];
  const byRealPath = new Map<string, ResolvedExtensionEntry>();
  const webByRealPath = new Map<string, ResolvedWebExtensionEntry>();

  const resolveEntries = async (entries: readonly PrcPackageSetting[] | undefined, scope: ResolvedExtensionEntry["scope"]) => {
    for (const entry of entries ?? []) {
      const source = packageSettingSource(entry);
      const installPath = packageSettingInstallPath(entry);
      const absoluteSource = path.resolve(options.cwd, installPath);
      try {
        const paths = await resolveSinglePackageExtensions(absoluteSource, typeof entry === "string" ? undefined : entry.extensions);
        const webPath = await resolveSinglePackageWebExtension(absoluteSource);
        if (webPath) {
          const realWeb = await fs.realpath(webPath).catch(() => webPath);
          const existingWeb = webByRealPath.get(realWeb);
          if (!existingWeb || (existingWeb.scope === "global" && scope === "project")) {
            webByRealPath.set(realWeb, { packageSource: absoluteSource, path: webPath, scope });
          }
        }
        for (const extensionPath of paths) {
          const real = await fs.realpath(extensionPath).catch(() => extensionPath);
          const existing = byRealPath.get(real);
          if (existing && !(existing.scope === "global" && scope === "project")) continue;
          byRealPath.set(real, { packageSource: absoluteSource, path: extensionPath, scope });
        }
      } catch (error) {
        diagnostics.push({ source: absoluteSource, level: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  await resolveEntries(settings.packages, "global");
  await resolveEntries(settings.projectPackages, "project");
  return { extensions: [...byRealPath.values()], webExtensions: [...webByRealPath.values()], diagnostics };
}

export async function resolveSinglePackageWebExtension(packageSource: string): Promise<string | undefined> {
  const stat = await fs.stat(packageSource);
  if (!stat.isDirectory()) return undefined;
  const manifest = await readPackageManifest(packageSource);
  const web = manifest ? readManifestWebConfig(manifest) : undefined;
  if (!web) return undefined;
  const absolute = path.resolve(packageSource, web);
  try {
    const webStat = await fs.stat(absolute);
    return webStat.isFile() ? absolute : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Web extension path does not exist: ${absolute}`);
    throw error;
  }
}

export async function resolveSinglePackageExtensions(packageSource: string, extensionPatterns?: readonly string[]): Promise<string[]> {
  const stat = await fs.stat(packageSource);
  if (stat.isFile()) return isExtensionFile(packageSource) ? [packageSource] : [];
  if (!stat.isDirectory()) return [];

  const manifest = await readPackageManifest(packageSource);
  const manifestConfig = manifest ? readManifestExtensionConfig(manifest) : undefined;
  const patterns = manifestConfig && extensionPatterns ? [...manifestConfig, ...extensionPatterns] : (extensionPatterns ?? manifestConfig);
  if (patterns?.length) return applyPatterns(packageSource, patterns);

  const index = await firstExisting([
    path.join(packageSource, "index.js"),
    path.join(packageSource, "index.mjs"),
    path.join(packageSource, "index.ts"),
    path.join(packageSource, "src", "index.ts"),
  ]);
  if (index) return [index];

  const extensionsDir = path.join(packageSource, "extensions");
  try {
    const extensionsStat = await fs.stat(extensionsDir);
    if (extensionsStat.isDirectory()) return discoverExtensionDirectory(extensionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [];
}

function packageSettingSource(entry: PrcPackageSetting): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageSettingInstallPath(entry: PrcPackageSetting): string {
  if (typeof entry === "string") return entry;
  return entry.installedPath ?? entry.source;
}

function packageSettingMatches(entry: PrcPackageSetting, source: string, absoluteSource: string, configDir: string): boolean {
  if (packageSettingSource(entry) === source) return true;
  const installed = packageSettingInstallPath(entry);
  return installed === source || path.resolve(configDir, installed) === absoluteSource;
}

async function assertPackageSourceExists(absoluteSource: string): Promise<void> {
  try { await fs.stat(absoluteSource); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Package source does not exist: ${absoluteSource}`);
    throw error;
  }
}

function relativeOrAbsolute(fromDir: string, absolutePath: string): string {
  const relative = path.relative(fromDir, absolutePath);
  return relative || ".";
}

function normalizeSettingPath(value: string): string {
  return normalizePath(value).replace(/\/+$/g, "");
}

async function readPackageManifest(packageDir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readManifestExtensionConfig(manifest: Record<string, unknown>): string[] | undefined {
  const prc = manifest.piRemoteControl;
  if (isRecord(prc)) {
    const extensions = prc.extensions;
    if (Array.isArray(extensions) && extensions.every((value) => typeof value === "string")) return extensions;
    if (typeof prc.extension === "string") return [prc.extension];
  }
  return undefined;
}

function readManifestWebConfig(manifest: Record<string, unknown>): string | undefined {
  const prc = manifest.piRemoteControl;
  if (isRecord(prc) && typeof prc.web === "string") return prc.web;
  return undefined;
}

async function applyPatterns(root: string, patterns: readonly string[]): Promise<string[]> {
  const includePatterns = patterns.filter((pattern) => !isExcludePattern(pattern) && !isForceIncludePattern(pattern));
  const excludePatterns = patterns.filter(isExcludePattern).map((pattern) => pattern.slice(1));
  const forceIncludePatterns = patterns.filter(isForceIncludePattern).map((pattern) => pattern.slice(1));
  const forceExcludePatterns = patterns.filter(isForceExcludePattern).map((pattern) => pattern.slice(1));
  const candidates = includePatterns.length
    ? (await Promise.all(includePatterns.map((pattern) => expandPattern(root, pattern)))).flat()
    : await discoverExtensionDirectory(root);
  const forceIncluded = (await Promise.all(forceIncludePatterns.map((pattern) => expandPattern(root, pattern)))).flat();
  const unique = new Map<string, string>();
  for (const candidate of [...candidates, ...forceIncluded]) unique.set(path.resolve(candidate), path.resolve(candidate));
  return [...unique.values()]
    .filter((candidate) => !excludePatterns.some((pattern) => matchesPattern(root, candidate, pattern)) || forceIncludePatterns.some((pattern) => matchesPattern(root, candidate, pattern)))
    .filter((candidate) => !forceExcludePatterns.some((pattern) => matchesPattern(root, candidate, pattern)))
    .sort();
}

async function expandPattern(root: string, rawPattern: string): Promise<string[]> {
  const pattern = stripPatternPrefix(rawPattern);
  const absolute = path.resolve(root, pattern);
  if (!pattern.includes("*")) {
    try {
      const stat = await fs.stat(absolute);
      if (stat.isDirectory()) return discoverExtensionDirectory(absolute);
      return isExtensionFile(absolute) ? [absolute] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Extension path does not exist: ${absolute}`);
      throw error;
    }
  }
  const all = await collectExtensionFiles(root);
  return all.filter((candidate) => matchesPattern(root, candidate, pattern));
}

function matchesPattern(root: string, candidate: string, pattern: string): boolean {
  const relative = normalizePath(path.relative(root, candidate));
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern === "**/*") return true;
  if (normalizedPattern.startsWith("**/")) return relative.endsWith(normalizedPattern.slice(3));
  if (normalizedPattern.endsWith("/**")) return relative.startsWith(normalizedPattern.slice(0, -3));
  if (normalizedPattern.includes("*")) {
    return globToRegExp(normalizedPattern).test(relative);
  }
  return relative === normalizedPattern || relative.startsWith(`${normalizedPattern}/`);
}

async function discoverExtensionDirectory(dir: string): Promise<string[]> {
  const result: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && isExtensionFile(fullPath)) {
      result.push(fullPath);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const manifest = await readPackageManifest(fullPath);
    const manifestConfig = manifest ? readManifestExtensionConfig(manifest) : undefined;
    if (manifestConfig?.length) {
      result.push(...await applyPatterns(fullPath, manifestConfig));
      continue;
    }
    const index = await firstExisting([
      path.join(fullPath, "index.js"),
      path.join(fullPath, "index.mjs"),
      path.join(fullPath, "index.ts"),
      path.join(fullPath, "index.tsx"),
    ]);
    if (index) result.push(index);
  }
  return [...new Set(result.map((entry) => path.resolve(entry)))].sort();
}

async function collectExtensionFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await collectExtensionFiles(fullPath));
    else if (entry.isFile() && isExtensionFile(fullPath)) result.push(fullPath);
  }
  return result.sort();
}

function isExcludePattern(pattern: string): boolean {
  return pattern.startsWith("!");
}

function isForceIncludePattern(pattern: string): boolean {
  return pattern.startsWith("+");
}

function isForceExcludePattern(pattern: string): boolean {
  return pattern.startsWith("-");
}

function stripPatternPrefix(pattern: string): string {
  return pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-") ? pattern.slice(1) : pattern;
}

function isExtensionFile(filePath: string): boolean {
  return EXTENSION_FILE_EXTENSIONS.has(path.extname(filePath));
}

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try { await fs.access(candidate); return candidate; }
    catch { /* try next */ }
  }
  return undefined;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
