import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapPrcExtensions, defaultPrcConfigDir } from "../../src/extensions/bootstrap.js";
import { installExtensionPackage, writePrcSettings } from "../../src/extensions/packages.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";
import { writeLocalExtensionPackage } from "../helpers/local-extension-package.js";

let homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("pi-crust extension bootstrap integration", () => {
  it("loads explicit, project, global, and built-in extensions in precedence order", async () => {
    const home = await makeHome();
    const explicitFile = path.join(home.root, "explicit.mjs");
    await fs.writeFile(explicitFile, commandModule("explicit"), "utf8");
    const projectPackage = await writePackage(home.projectRoot, "project-extension", "project");
    const globalPackage = await writePackage(home.configDir, "global-extension", "global");
    await installExtensionPackage(globalPackage, { configDir: home.configDir });
    await writePrcSettings(home.configDir, {
      packages: ["global-extension"],
      projectPackages: [projectPackage],
    });

    const result = await bootstrapPrcExtensions({
      configDir: home.configDir,
      cwd: home.projectRoot,
      explicitExtensionPaths: [explicitFile],
      builtIns: [{ id: "builtin-extension", factory: (prc) => prc.commands.register({ id: "shared", title: "Built-in", run: () => "builtin" }) }],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.host.commands.list().map((command) => `${command.invocationName}:${command.extensionId}`)).toEqual([
      "shared:explicit:explicit",
      "shared:1:project-extension",
      "shared:2:global-extension",
      "shared:3:builtin-extension",
    ]);
    await expect(result.host.commands.run("shared")).resolves.toBe("explicit");
  });

  it("passes session helper services into bootstrapped extensions", async () => {
    const home = await makeHome();
    const prompts: Array<{ sessionId: string; prompt: string }> = [];
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "session-extension",
      extensionCode: "export default async function activate(prc) { prc.commands.register({ id: 'session.run', title: 'Run', run: () => prc.sessions.createAndPrompt({ cwd: '/repo', sessionName: 'From ext', prompt: 'hello' }) }); }\n",
    });

    const result = await bootstrapPrcExtensions({
      configDir: home.configDir,
      cwd: home.projectRoot,
      bundledPackagePaths: [packageDir],
      sessions: {
        create: async (input) => ({ id: "created-session", ...input }),
        prompt: async (sessionId, prompt) => { prompts.push({ sessionId, prompt }); },
      },
    });

    await expect(result.host.commands.run("session.run")).resolves.toMatchObject({ id: "created-session", sessionName: "From ext" });
    expect(prompts).toEqual([{ sessionId: "created-session", prompt: "hello" }]);
  });

  it("auto-discovers project and global extension directories", async () => {
    const home = await makeHome();
    const projectPackage = await writeLocalExtensionPackage(path.join(home.projectRoot, ".pi", "remote-control", "extensions"), {
      name: "project-discovered",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'discovered.project', title: 'Project', run: () => 'project' }); }\n",
    });
    const globalPackage = await writeLocalExtensionPackage(path.join(home.configDir, "extensions"), {
      name: "global-discovered",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'discovered.global', title: 'Global', run: () => 'global' }); }\n",
    });

    const result = await bootstrapPrcExtensions({ configDir: home.configDir, cwd: home.projectRoot });

    expect(projectPackage).toContain("project-discovered");
    expect(globalPackage).toContain("global-discovered");
    await expect(result.host.commands.run("discovered.project")).resolves.toBe("project");
    await expect(result.host.commands.run("discovered.global")).resolves.toBe("global");
  });

  it("skips disabled extensions and their web assets from settings", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "disabled-extension",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'disabled.hello', title: 'Disabled', run: () => 'nope' }); prc.activity.registerView({ id: 'disabled.panel', title: 'Disabled' }); }\n",
      manifest: {
        name: "disabled-extension",
        version: "0.0.0-test",
        piRemoteControl: { extension: "./index.mjs", web: "./web.mjs" },
      },
    });
    await fs.writeFile(path.join(packageDir, "web.mjs"), "export default function Disabled() {}\n", "utf8");
    await writePrcSettings(home.configDir, { disabledExtensions: ["disabled-extension", "disabled-builtin"] });

    const result = await bootstrapPrcExtensions({
      configDir: home.configDir,
      cwd: home.projectRoot,
      bundledPackagePaths: [packageDir],
      builtIns: [{ id: "disabled-builtin", factory: (prc) => prc.commands.register({ id: "builtin.nope", title: "Nope", run: () => "nope" }) }],
    });

    expect(result.host.commands.list()).toEqual([]);
    expect(result.host.activity.list()).toEqual([]);
    expect(result.host.getWebAsset("disabled-extension")).toBeUndefined();
  });

  it("loads bundled package paths through the same package resolver as installed extensions", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "bundled-extension",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'bundled.hello', title: 'Bundled', run: () => 'bundled' }); prc.activity.registerView({ id: 'bundled.panel', title: 'Bundled' }); }\n",
      manifest: {
        name: "bundled-extension",
        version: "0.0.0-test",
        piRemoteControl: { extension: "./index.mjs", web: "./web.mjs" },
      },
    });
    await fs.writeFile(path.join(packageDir, "web.mjs"), "export default function Web() {}\n", "utf8");

    const result = await bootstrapPrcExtensions({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [packageDir] });

    await expect(result.host.commands.run("bundled.hello")).resolves.toBe("bundled");
    expect(result.host.activity.get("bundled.panel")?.extensionId).toBe("bundled-extension");
    expect(result.host.getWebAsset("bundled-extension")?.filePath).toBe(path.join(packageDir, "web.mjs"));
  });

  it("honors PI_CRUST_EXTENSIONS and PI_CRUST_NO_EXTENSIONS", async () => {
    const home = await makeHome();
    const envFile = path.join(home.root, "env-extension.mjs");
    await fs.writeFile(envFile, commandModule("env"), "utf8");

    const enabled = await bootstrapPrcExtensions({
      configDir: home.configDir,
      cwd: home.projectRoot,
      env: { ...process.env, PI_CRUST_EXTENSIONS: envFile },
    });
    const disabled = await bootstrapPrcExtensions({
      configDir: home.configDir,
      cwd: home.projectRoot,
      env: { ...process.env, PI_CRUST_EXTENSIONS: envFile, PI_CRUST_NO_EXTENSIONS: "1" },
    });

    await expect(enabled.host.commands.run("shared")).resolves.toBe("env");
    expect(disabled.host.commands.list()).toEqual([]);
  });

  it("registers package web module assets during bootstrap", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.configDir, {
      name: "webby-extension",
      extensionCode: "export default function activate(prc) { prc.activity.registerView({ id: 'webby.panel', title: 'Webby' }); }\n",
      manifest: {
        name: "webby-extension",
        version: "0.0.0-test",
        piRemoteControl: { extension: "./index.mjs", web: "./web.mjs" },
      },
    });
    await fs.writeFile(path.join(packageDir, "web.mjs"), "export default function Webby() {}\n", "utf8");
    await writePrcSettings(home.configDir, { packages: ["webby-extension"] });

    const result = await bootstrapPrcExtensions({ configDir: home.configDir, cwd: home.projectRoot });

    expect(result.diagnostics).toEqual([]);
    expect(result.host.getWebAsset("webby-extension")).toEqual({
      extensionId: "webby-extension",
      filePath: path.join(packageDir, "web.mjs"),
      urlPath: expect.stringContaining("/api/extensions/webby-extension/assets/web.mjs?v="),
    });
  });

  it("reports diagnostics for invalid configured package extension modules without aborting bootstrap", async () => {
    const home = await makeHome();
    const badPackage = await writeLocalExtensionPackage(home.configDir, {
      name: "bad-extension",
      extensionCode: "export const nope = true;\n",
    });
    await writePrcSettings(home.configDir, { packages: [path.relative(home.configDir, badPackage)] });

    const result = await bootstrapPrcExtensions({ configDir: home.configDir, cwd: home.projectRoot });

    expect(result.host.commands.list()).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.source).toBe(path.join(badPackage, "index.mjs"));
    expect(result.diagnostics[0]?.message).toContain("does not export an activate function");
  });

  it("reports diagnostics for missing explicit extension paths", async () => {
    const home = await makeHome();
    const missing = path.join(home.root, "missing.mjs");

    const result = await bootstrapPrcExtensions({ configDir: home.configDir, cwd: home.projectRoot, explicitExtensionPaths: [missing] });

    expect(result.host.commands.list()).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.source).toBe(missing);
  });

  it("uses PI_CRUST_CONFIG_DIR before the default home config dir", () => {
    expect(defaultPrcConfigDir({ HOME: "/home/test", PI_CRUST_CONFIG_DIR: "/tmp/prc" })).toBe("/tmp/prc");
    expect(defaultPrcConfigDir({ HOME: "/home/test" })).toBe("/home/test/.pi-crust");
  });
});

async function writePackage(root: string, name: string, value: string): Promise<string> {
  return writeLocalExtensionPackage(root, {
    name,
    extensionCode: commandModule(value),
  });
}

function commandModule(value: string): string {
  return `export default function activate(prc) { prc.commands.register({ id: 'shared', title: '${value}', run: () => '${value}' }); }\n`;
}

async function makeHome(): Promise<TempPrcHome> {
  const home = await createTempPrcHome();
  homes.push(home);
  return home;
}
