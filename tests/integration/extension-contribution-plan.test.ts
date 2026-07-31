import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapPrcExtensions } from "../../src/extensions/bootstrap.js";
import { createExtensionContributionPlan } from "../../src/extensions/lifecycle/extension-contribution-plan.js";
import { writePrcSettings } from "../../src/extensions/packages.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";
import { writeLocalExtensionPackage } from "../helpers/local-extension-package.js";

let homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("extension contribution-plan boundary", () => {
  it("resolves source precedence once, then bootstrap activates that contract and registers its web asset", async () => {
    const home = await makeHome();
    const globalPackage = await writePackage(home.configDir, "shared-extension", "global", "global.mjs");
    const bundledPackage = await writePackage(home.root, "shared-extension", "bundled", "bundled.mjs");
    await writePrcSettings(home.configDir, { packages: [path.relative(home.configDir, globalPackage)] });

    const plan = await createExtensionContributionPlan({
      configDir: home.configDir,
      cwd: home.projectRoot,
      env: process.env,
      bundledPackagePaths: [bundledPackage],
    });
    const contribution = plan.plan.find((entry) => entry.id === "shared-extension");
    expect(contribution).toMatchObject({
      id: "shared-extension",
      packageSource: bundledPackage,
      scope: "global",
      serverEntry: path.join(bundledPackage, "bundled.mjs"),
      webEntry: path.join(bundledPackage, "web.mjs"),
    });
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", message: expect.stringContaining('duplicate extension "shared-extension"') }));

    const boot = await bootstrapPrcExtensions({
      configDir: home.configDir,
      cwd: home.projectRoot,
      bundledPackagePaths: [bundledPackage],
    });
    await expect(boot.host.commands.run("shared.command")).resolves.toBe("bundled");
    expect(boot.host.getWebAsset("shared-extension")?.filePath).toBe(path.join(bundledPackage, "web.mjs"));
    expect(boot.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", message: expect.stringContaining('duplicate extension "shared-extension"') }));
  });

  it("carries disabled ids across the plan boundary so built-ins stay disabled", async () => {
    const home = await makeHome();
    await writePrcSettings(home.configDir, { disabledExtensions: ["builtin-disabled"] });

    const plan = await createExtensionContributionPlan({ configDir: home.configDir, cwd: home.projectRoot, env: process.env });
    expect(plan.disabledExtensionIds.has("builtin-disabled")).toBe(true);

    const boot = await bootstrapPrcExtensions({
      configDir: home.configDir,
      cwd: home.projectRoot,
      builtIns: [{ id: "builtin-disabled", factory: (prc) => prc.commands.register({ id: "disabled", title: "Disabled", run: () => "no" }) }],
    });
    expect(boot.host.commands.list()).toEqual([]);
  });
});

async function writePackage(root: string, name: string, value: string, extensionFile: string): Promise<string> {
  const packageDir = await writeLocalExtensionPackage(root, {
    name,
    extensionFile,
    extensionCode: `export default function activate(prc) { prc.commands.register({ id: 'shared.command', title: 'Shared', run: () => '${value}' }); }\n`,
    manifest: { name, version: "0.0.0-test", piRemoteControl: { extension: `./${extensionFile}`, web: "./web.mjs" } },
  });
  await fs.writeFile(path.join(packageDir, "web.mjs"), "export default function Web() {}\n", "utf8");
  return packageDir;
}

async function makeHome(): Promise<TempPrcHome> {
  const home = await createTempPrcHome();
  homes.push(home);
  return home;
}
