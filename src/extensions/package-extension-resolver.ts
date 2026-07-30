import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../shared/util.js";

const EXTENSION_FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);

/** Resolve the optional browser entry declared by an extension package. */
export async function resolvePackageWebExtensionFile(packageSource: string): Promise<string | undefined> {
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

/**
 * Resolve server extension entry files from package manifests, conventional
 * indexes, and Pi-style extension directories. Pattern handling lives here so
 * every discovery path applies the same include/exclude semantics.
 */
export async function resolvePackageExtensionFiles(packageSource: string, extensionPatterns?: readonly string[]): Promise<string[]> {
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
  if (normalizedPattern.includes("*")) return globToRegExp(normalizedPattern).test(relative);
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
