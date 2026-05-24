import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadResolvedExtensionEntries } from "../../src/extensions/loader.js";
import { installExtensionPackage, readPrcSettings, removeExtensionPackage, resolvePackageExtensions } from "../../src/extensions/packages.js";
import { createPrcExtensionHost } from "../../src/extensions/registry.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";
import { writeLocalExtensionPackage } from "../helpers/local-extension-package.js";

const execFileAsync = promisify(execFile);
let homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("pi-crust extension package install harness", () => {
  it("installs a local extension package into isolated settings", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.configDir, { name: "local-extension" });

    const settings = await installExtensionPackage(packageDir, { configDir: home.configDir });

    expect(settings.packages).toEqual(["local-extension"]);
    await expect(readPrcSettings(home.configDir)).resolves.toEqual({ packages: ["local-extension"] });
  });

  it("dedupes repeated installs of the same package", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.configDir, { name: "dedupe-extension" });

    await installExtensionPackage(packageDir, { configDir: home.configDir });
    const settings = await installExtensionPackage(path.join(home.configDir, "dedupe-extension"), { configDir: home.configDir });

    expect(settings.packages).toEqual(["dedupe-extension"]);
  });

  it("removes local packages using equivalent path forms", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.configDir, { name: "removable-extension" });

    await installExtensionPackage(packageDir, { configDir: home.configDir });
    const settings = await removeExtensionPackage("removable-extension/", { configDir: home.configDir });

    expect(settings.packages).toEqual([]);
    await expect(readPrcSettings(home.configDir)).resolves.toEqual({ packages: [] });
  });

  it("resolves, imports, activates, and verifies a locally installed extension package", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.configDir, {
      name: "loadable-extension",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'loadable.hello', title: 'Hello', run: () => `hello from ${prc.extensionId}` }); }\n",
    });

    const settings = await installExtensionPackage(packageDir, { configDir: home.configDir });
    const resolved = await resolvePackageExtensions(settings, { cwd: home.configDir });
    const host = createPrcExtensionHost();
    await host.activateAll(await loadResolvedExtensionEntries(resolved.extensions));

    expect(resolved.diagnostics).toEqual([]);
    await expect(host.commands.run("loadable.hello")).resolves.toBe("hello from loadable-extension");
  });

  it("installs a git extension package from a local repository using the real git runner", async () => {
    const home = await makeHome();
    const repo = path.join(home.root, "git-extension-src");
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "git-extension", version: "0.0.0", piRemoteControl: { extension: "./index.mjs" } }), "utf8");
    await fs.writeFile(path.join(repo, "index.mjs"), "export default function activate(prc) { prc.commands.register({ id: 'git.hello', title: 'Git', run: () => 'git' }); }\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "pi-crust Test"], { cwd: repo });
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });

    const settings = await installExtensionPackage(`git:${repo}`, { configDir: home.configDir });
    const resolved = await resolvePackageExtensions(settings, { cwd: home.configDir });
    const host = createPrcExtensionHost();
    await host.activateAll(await loadResolvedExtensionEntries(resolved.extensions));

    expect(settings.packages).toEqual([{ source: `git:${repo}`, installedPath: `packages/git/${repo.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "")}`, kind: "git" }]);
    await expect(host.commands.run("git.hello")).resolves.toBe("git");
  });

  it("reports a clear error for missing package sources", async () => {
    const home = await makeHome();

    await expect(installExtensionPackage("does-not-exist", { configDir: home.configDir, cwd: home.projectRoot }))
      .rejects.toThrow(`Package source does not exist: ${path.join(home.projectRoot, "does-not-exist")}`);
  });
});

async function makeHome(): Promise<TempPrcHome> {
  const home = await createTempPrcHome();
  homes.push(home);
  return home;
}
