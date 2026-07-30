/**
 * Server-side glue: turn the persisted package settings into update-check
 * entries (reading installed versions/shas off disk) and run the check.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { uniqueValues } from "../shared/util.js";
import { packageInstallTarget, type PrcPackageSetting, type PrcSettings } from "./packages.js";
import {
  checkAllSources,
  type CheckOptions,
  type SourceCheckEntry,
  type SourceUpdate,
} from "./update-check.js";

function packageSettingSource(entry: PrcPackageSetting): string {
  return typeof entry === "string" ? entry : entry.source;
}

/** Read the installed version (package.json) and/or git HEAD sha for a source. */
export async function readInstalledIdentity(
  source: string,
  configDir: string,
): Promise<{ version?: string; sha?: string }> {
  const target = packageInstallTarget(source, configDir);
  const result: { version?: string; sha?: string } = {};
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8")) as { version?: string };
    if (typeof manifest.version === "string") result.version = manifest.version;
  } catch { /* no manifest */ }
  const sha = await gitHeadSha(target);
  if (sha) result.sha = sha;
  return result;
}

async function gitHeadSha(target: string): Promise<string | undefined> {
  try {
    const head = (await fs.readFile(path.join(target, ".git", "HEAD"), "utf8")).trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return /^[0-9a-f]{7,40}$/i.test(head) ? head : undefined;
    const refPath = path.join(target, ".git", ref[1]!.trim());
    const sha = (await fs.readFile(refPath, "utf8")).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Build one check entry per configured source (global + project). */
export async function buildSourceCheckEntries(settings: PrcSettings, configDir: string): Promise<SourceCheckEntry[]> {
  const sources = [
    ...(settings.packages ?? []),
    ...(settings.projectPackages ?? []),
  ].map(packageSettingSource);
  return Promise.all(uniqueValues(sources).map(async (source) => {
    const identity = await readInstalledIdentity(source, configDir);
    return {
      source,
      ...(identity.version ? { installedVersion: identity.version } : {}),
      ...(identity.sha ? { installedSha: identity.sha } : {}),
    } satisfies SourceCheckEntry;
  }));
}

export interface ExtensionUpdateServiceOptions extends CheckOptions {
  readonly configDir: string;
}

/** High-level: settings → per-source update statuses. */
export async function checkExtensionUpdates(
  settings: PrcSettings,
  options: ExtensionUpdateServiceOptions,
): Promise<SourceUpdate[]> {
  const entries = await buildSourceCheckEntries(settings, options.configDir);
  const npmPrefix = path.join(options.configDir, "packages", "npm");
  return checkAllSources(entries, { cwd: npmPrefix, ...options });
}
