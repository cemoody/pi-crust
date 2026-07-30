import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PrcExtensionFactory, PrcExtensionModule } from "./api.js";
import type { ActivateExtensionInput } from "./registry.js";
import type { ResolvedExtensionEntry } from "./packages.js";

export async function loadPrcExtensionFactory(filePath: string): Promise<PrcExtensionFactory> {
  const url = pathToFileURL(filePath);
  const stat = await fs.stat(filePath);
  url.searchParams.set("mtime", String(stat.mtimeMs));
  url.searchParams.set("size", String(stat.size));
  const module = await import(url.href) as PrcExtensionModule;
  const candidate = module.default ?? module;
  if (typeof candidate === "function") return candidate;
  if (candidate && typeof candidate === "object" && typeof candidate.activate === "function") return candidate.activate;
  if (typeof module.activate === "function") return module.activate;
  throw new Error(`Extension module does not export an activate function: ${filePath}`);
}

export async function loadResolvedExtensionEntries(entries: readonly ResolvedExtensionEntry[]): Promise<ActivateExtensionInput[]> {
  const loaded: ActivateExtensionInput[] = [];
  for (const entry of entries) {
    loaded.push({
      id: await inferPrcExtensionId(entry.packageSource, entry.path),
      factory: await loadPrcExtensionFactory(entry.path),
    });
  }
  return loaded;
}

/**
 * Resolve the stable id shared by all entries in one extension package.
 * Package manifests take precedence; paths provide a useful fallback for
 * single-file and malformed local packages.
 */
export async function inferPrcExtensionId(packageSource: string, fallbackPath: string): Promise<string> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(packageSource, "package.json"), "utf8")) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name;
  } catch { /* fall back to directory/file name */ }
  return path.basename(packageSource) || path.basename(fallbackPath, path.extname(fallbackPath));
}
