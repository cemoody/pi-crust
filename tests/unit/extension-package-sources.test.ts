import { describe, expect, it } from "vitest";
import path from "node:path";
import { installExtensionPackage, parsePackageSource, readPrcSettings, removeExtensionPackage } from "../../src/extensions/packages.js";
import { createTempPrcHome } from "../helpers/temp-pi-crust-home.js";

describe("extension package source support", () => {
  it("parses local, npm, and git package sources", () => {
    expect(parsePackageSource("./ext")).toEqual({ type: "local", source: "./ext" });
    expect(parsePackageSource("npm:@scope/pkg@1.2.3")).toEqual({ type: "npm", spec: "@scope/pkg@1.2.3", packageName: "@scope/pkg" });
    expect(parsePackageSource("git:https://github.com/acme/ext@v1")).toEqual({ type: "git", url: "https://github.com/acme/ext", ref: "v1" });
    expect(parsePackageSource("https://github.com/acme/ext")).toEqual({ type: "git", url: "https://github.com/acme/ext" });
  });

  it("installs npm sources into the managed package root using the command runner", async () => {
    const home = await createTempPrcHome();
    const calls: unknown[] = [];
    try {
      await installExtensionPackage("npm:@scope/pkg@1.2.3", {
        configDir: home.configDir,
        runner: async (command, args, options) => { calls.push({ command, args, options }); },
      });
      expect(calls).toEqual([{ command: "npm", args: ["install", "--prefix", path.join(home.configDir, "packages", "npm"), "@scope/pkg@1.2.3"], options: { cwd: home.configDir } }]);
      expect(await readPrcSettings(home.configDir)).toEqual({ packages: [{ source: "npm:@scope/pkg@1.2.3", installedPath: "packages/npm/node_modules/@scope/pkg", kind: "npm" }] });
    } finally {
      await home.cleanup();
    }
  });

  it("removes remote package installs by their original npm source", async () => {
    const home = await createTempPrcHome();
    try {
      await installExtensionPackage("npm:@scope/pkg@1.2.3", {
        configDir: home.configDir,
        runner: async () => undefined,
      });
      await removeExtensionPackage("npm:@scope/pkg@1.2.3", { configDir: home.configDir });
      expect(await readPrcSettings(home.configDir)).toEqual({ packages: [] });
    } finally {
      await home.cleanup();
    }
  });

  it("installs git sources into the managed package root using the command runner", async () => {
    const home = await createTempPrcHome();
    const calls: unknown[] = [];
    try {
      await installExtensionPackage("git:https://github.com/acme/ext@v1", {
        configDir: home.configDir,
        runner: async (command, args, options) => { calls.push({ command, args, options }); },
      });
      const target = path.join(home.configDir, "packages", "git", "https_github.com_acme_ext");
      expect(calls).toEqual([
        { command: "git", args: ["clone", "https://github.com/acme/ext", target], options: { cwd: home.configDir } },
        { command: "git", args: ["checkout", "v1"], options: { cwd: target } },
      ]);
      expect(await readPrcSettings(home.configDir)).toEqual({ packages: [{ source: "git:https://github.com/acme/ext@v1", installedPath: "packages/git/https_github.com_acme_ext", kind: "git" }] });
    } finally {
      await home.cleanup();
    }
  });
});
