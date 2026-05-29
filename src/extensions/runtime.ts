import path from "node:path";
import type { BootstrapPrcExtensionsOptions, ResolvedPrcExtensionContribution } from "./bootstrap.js";
import { bootstrapPrcExtensions } from "./bootstrap.js";
import type { PrcExtensionHost } from "./registry.js";

export interface PrcExtensionReloadResult {
  readonly applied: boolean;
  readonly diagnostics: readonly { readonly extensionId: string; readonly level: "error" | "warning"; readonly message: string }[];
}

export class PrcExtensionRuntime {
  private constructor(
    private readonly options: BootstrapPrcExtensionsOptions,
    private activeHost: PrcExtensionHost,
  ) {}

  static async create(options: BootstrapPrcExtensionsOptions): Promise<PrcExtensionRuntime> {
    const boot = await bootstrapPrcExtensions(options);
    return new PrcExtensionRuntime(options, boot.host);
  }

  get current(): PrcExtensionHost {
    return this.activeHost;
  }

  get configDir(): string {
    return this.options.configDir;
  }

  get cwd(): string {
    return this.options.cwd;
  }

  getPiExtensionArgs(): readonly string[] {
    return piExtensionArgsFromPlan(this.activeHost.contributionPlan ?? []);
  }

  async reload(): Promise<PrcExtensionReloadResult> {
    const boot = await bootstrapPrcExtensions(this.options);
    const diagnostics = boot.host.diagnostics;
    if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
      await boot.host.dispose();
      return { applied: false, diagnostics };
    }
    const previous = this.activeHost;
    this.activeHost = boot.host;
    await previous.dispose();
    return { applied: true, diagnostics };
  }

  async dispose(): Promise<void> {
    await this.activeHost.dispose();
  }
}

export async function createPrcExtensionRuntime(options: BootstrapPrcExtensionsOptions): Promise<PrcExtensionRuntime> {
  return PrcExtensionRuntime.create(options);
}

function piExtensionArgsFromPlan(plan: readonly ResolvedPrcExtensionContribution[]): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const contribution of plan) {
    if (!contribution.enabled) continue;
    for (const extensionPath of contribution.piExtensionEntries ?? []) {
      const absolute = path.isAbsolute(extensionPath)
        ? extensionPath
        : path.resolve(contribution.packageSource, extensionPath);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      args.push("--extension", absolute);
    }
  }
  return args;
}
