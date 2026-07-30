import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrcExtensionHost } from "./registry.js";

import { optional } from "../shared/util.js";
export interface SerializedExtensionRegistry {
  readonly commands: readonly {
    readonly id: string;
    readonly invocationName: string;
    readonly title: string;
    readonly description?: string;
    readonly slashName?: string;
    readonly extensionId: string;
  }[];
  readonly activities: readonly {
    readonly id: string;
    readonly title: string;
    readonly order?: number;
    readonly icon?: string;
    readonly extensionId: string;
    readonly webModuleUrl?: string;
  }[];
  readonly settings: readonly {
    readonly id: string;
    readonly title: string;
    readonly order?: number;
    readonly description?: string;
    readonly extensionId: string;
    readonly webModuleUrl?: string;
  }[];
  readonly routes: readonly {
    readonly method: string;
    readonly path: string;
    readonly mount?: "api" | "extension";
    readonly extensionId: string;
  }[];
  readonly diagnostics: readonly {
    readonly extensionId: string;
    readonly level: "error" | "warning";
    readonly message: string;
  }[];
}

/** Per-package identity surfaced in the help dialog so an operator can tell
 *  exactly which version (or git SHA) of each extension is loaded — the
 *  extension analogue of the frontend/backend build SHAs. */
export interface SerializedExtensionPackage {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  /** Commit SHA when the package was installed from git (e.g. a pinned
   *  `#<sha>` dependency whose package.json `version` is uninformative). */
  readonly sha?: string;
  readonly scope?: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly gitHead?: string;
}

export interface SerializeExtensionPackagesDeps {
  /** Read a package's manifest given its directory. Injectable for tests. */
  readonly readManifest?: (dir: string) => PackageManifest | null;
  /** Resolve a git SHA for a package by name (e.g. from package-lock.json). */
  readonly gitShaForPackage?: (name: string | undefined) => string | undefined;
}

function defaultReadManifest(dir: string): PackageManifest | null {
  try {
    const raw = readFileSync(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as PackageManifest;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build a name -> commit-SHA map from a package-lock.json by parsing the
 * `#<sha>` suffix of git `resolved` URLs. Source checkouts ship a lockfile so
 * git-pinned extensions (whose own package.json version is often "0.0.0")
 * still surface a meaningful identifier; a published `npx pi-crust` has no
 * lockfile and simply falls back to the package version.
 */
export function readLockfileGitShas(cwd: string, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): Map<string, string> {
  const map = new Map<string, string>();
  let lock: { packages?: Record<string, { resolved?: string }> };
  try {
    lock = JSON.parse(readFile(path.join(cwd, "package-lock.json")));
  } catch {
    return map;
  }
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    const resolved = value?.resolved;
    if (typeof resolved !== "string") continue;
    const hash = resolved.indexOf("#");
    if (hash === -1) continue;
    const sha = resolved.slice(hash + 1);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    // Lock keys look like "node_modules/@scope/name"; the package name is
    // everything after the final "node_modules/".
    const marker = "node_modules/";
    const idx = key.lastIndexOf(marker);
    const name = idx === -1 ? key : key.slice(idx + marker.length);
    if (name) map.set(name, sha.slice(0, 12));
  }
  return map;
}

export function serializeExtensionPackages(
  extensions: PrcExtensionHost | undefined,
  deps: SerializeExtensionPackagesDeps = {},
): SerializedExtensionPackage[] {
  const plan = extensions?.contributionPlan ?? [];
  const readManifest = deps.readManifest ?? defaultReadManifest;
  const seen = new Set<string>();
  const result: SerializedExtensionPackage[] = [];
  for (const contribution of plan) {
    if (seen.has(contribution.id)) continue;
    seen.add(contribution.id);
    const manifest = readManifest(contribution.packageSource) ?? {};
    const sha = manifest.gitHead ?? deps.gitShaForPackage?.(manifest.name);
    result.push({
      id: contribution.id,
      ...optional({ name: manifest.name }),
      ...optional({ version: manifest.version }),
      ...optional({ sha: typeof sha === "string" ? sha.slice(0, 12) : undefined }),
      scope: contribution.scope,
    });
  }
  return result;
}

export function serializeExtensions(extensions: PrcExtensionHost | undefined): SerializedExtensionRegistry {
  if (!extensions) return { commands: [], activities: [], settings: [], routes: [], diagnostics: [] };
  return {
    commands: extensions.commands.list().map((command) => ({
      id: command.id,
      invocationName: command.invocationName,
      title: command.title,
      ...optional({ description: command.description }),
      ...optional({ slashName: command.slashName }),
      extensionId: command.extensionId,
    })),
    activities: extensions.activity.list().map((view) => ({
      id: view.id,
      title: view.title,
      ...optional({ order: view.order }),
      ...optional({ icon: view.icon }),
      extensionId: view.extensionId,
      ...extensionWebModuleUrl(extensions, view.extensionId),
    })),
    settings: extensions.settings.list().map((section) => ({
      id: section.id,
      title: section.title,
      ...optional({ order: section.order }),
      ...optional({ description: section.description }),
      extensionId: section.extensionId,
      ...extensionWebModuleUrl(extensions, section.extensionId),
    })),
    routes: extensions.serverRoutes.list().map((route) => ({
      method: route.method,
      path: route.path,
      mount: route.mount,
      extensionId: route.extensionId,
    })),
    diagnostics: extensions.diagnostics,
  };
}

/** Keep optional web-module serialization consistent for all UI contributions. */
function extensionWebModuleUrl(extensions: PrcExtensionHost, extensionId: string): { webModuleUrl?: string } {
  return optional({ webModuleUrl: extensions.getWebAsset(extensionId)?.urlPath });
}
