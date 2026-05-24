import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrcExtensionRuntime } from "../../src/extensions/runtime.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";
import { writeLocalExtensionPackage } from "../helpers/local-extension-package.js";

let homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("pi-crust extension hot reload runtime", () => {
  it("reloads changed package code and disposes old contributions", async () => {
    const home = await makeHome();
    const packageDir = await writeReloadablePackage(home, "v1");
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [packageDir] });

    await expect(runtime.current.commands.run("reload.value")).resolves.toBe("v1");

    await fs.writeFile(path.join(packageDir, "index.mjs"), moduleCode("v2"), "utf8");
    const result = await runtime.reload();

    expect(result).toEqual({ applied: true, diagnostics: [] });
    await expect(runtime.current.commands.run("reload.value")).resolves.toBe("v2");
    await expect(runtime.current.commands.run("reload.value:1")).rejects.toThrow("Command not found");
  });

  it("keeps the previous host active when reload has activation diagnostics", async () => {
    const home = await makeHome();
    const packageDir = await writeReloadablePackage(home, "good");
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [packageDir] });

    await fs.writeFile(path.join(packageDir, "index.mjs"), "export const nope = true;\n", "utf8");
    const result = await runtime.reload();

    expect(result.applied).toBe(false);
    expect(result.diagnostics[0]?.message).toContain("does not export an activate function");
    await expect(runtime.current.commands.run("reload.value")).resolves.toBe("good");
  });

  it("runs extension job stop hooks exactly once when a reload is applied", async () => {
    const home = await makeHome();
    const logPath = path.join(home.root, "reload.log");
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "job-extension",
      extensionCode: `import fs from 'node:fs'; export default function activate(prc) { prc.jobs.register({ id: 'job', start() { fs.appendFileSync(${JSON.stringify(logPath)}, 'start\\n'); }, stop() { fs.appendFileSync(${JSON.stringify(logPath)}, 'stop\\n'); } }); prc.commands.register({ id: 'job.value', title: 'Job', run: () => 'ok' }); }\n`,
    });
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [packageDir] });

    await runtime.reload();
    await runtime.dispose();

    expect(await fs.readFile(logPath, "utf8")).toBe("start\nstart\nstop\nstop\n");
  });

  it("refreshes web asset URLs to the new active host", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "web-reload-extension",
      extensionCode: "export default function activate(prc) { prc.activity.registerView({ id: 'web.panel', title: 'Web' }); }\n",
      manifest: { name: "web-reload-extension", version: "0.0.0-test", piRemoteControl: { extension: "./index.mjs", web: "./web.mjs" } },
    });
    await fs.writeFile(path.join(packageDir, "web.mjs"), "export const value = 1;\n", "utf8");
    const runtime = await createPrcExtensionRuntime({ configDir: home.configDir, cwd: home.projectRoot, bundledPackagePaths: [packageDir] });

    const before = runtime.current.getWebAsset("web-reload-extension")?.urlPath;
    expect(before).toContain("/api/extensions/web-reload-extension/assets/web.mjs?v=");
    await fs.writeFile(path.join(packageDir, "web.mjs"), "export const value = 2;\n", "utf8");
    expect((await runtime.reload()).applied).toBe(true);
    expect(runtime.current.getWebAsset("web-reload-extension")?.filePath).toBe(path.join(packageDir, "web.mjs"));
    expect(runtime.current.getWebAsset("web-reload-extension")?.urlPath).not.toBe(before);
  });
});

async function writeReloadablePackage(home: TempPrcHome, value: string): Promise<string> {
  return writeLocalExtensionPackage(home.root, {
    name: "reload-extension",
    extensionCode: moduleCode(value),
  });
}

function moduleCode(value: string): string {
  return `export default function activate(prc) { prc.commands.register({ id: 'reload.value', title: 'Reload Value', run: () => ${JSON.stringify(value)} }); }\n`;
}

async function makeHome(): Promise<TempPrcHome> {
  const home = await createTempPrcHome();
  homes.push(home);
  return home;
}
