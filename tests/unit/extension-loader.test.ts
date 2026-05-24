import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPrcExtensionFactory, loadResolvedExtensionEntries } from "../../src/extensions/loader.js";
import { resolvePackageExtensions } from "../../src/extensions/packages.js";
import { createPrcExtensionHost } from "../../src/extensions/registry.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";
import { writeLocalExtensionPackage } from "../helpers/local-extension-package.js";

let homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()))
});

describe("pi-crust extension dynamic loader", () => {
  it("loads a default function export", async () => {
    const filePath = await writeExtensionModule("default-function.mjs", "export default function activate(prc) { prc.commands.register({ id: 'loaded.default', title: 'Loaded', run: () => 'ok' }); }\n");

    const host = await activateFile(filePath);

    await expect(host.commands.run("loaded.default")).resolves.toBe("ok");
  });

  it("loads a named activate export", async () => {
    const filePath = await writeExtensionModule("named-activate.mjs", "export function activate(prc) { prc.commands.register({ id: 'loaded.named', title: 'Loaded', run: () => 'ok' }); }\n");

    const host = await activateFile(filePath);

    await expect(host.commands.run("loaded.named")).resolves.toBe("ok");
  });

  it("loads a default object with activate", async () => {
    const filePath = await writeExtensionModule("default-object.mjs", "export default { activate(prc) { prc.commands.register({ id: 'loaded.object', title: 'Loaded', run: () => 'ok' }); } };\n");

    const host = await activateFile(filePath);

    await expect(host.commands.run("loaded.object")).resolves.toBe("ok");
  });

  it("reports a clear error when a module has no activate export", async () => {
    const filePath = await writeExtensionModule("no-activate.mjs", "export const value = 42;\n");

    await expect(loadPrcExtensionFactory(filePath)).rejects.toThrow(`Extension module does not export an activate function: ${filePath}`);
  });

  it("surfaces syntax errors from invalid extension modules", async () => {
    const filePath = await writeExtensionModule("bad-syntax.mjs", "export default function activate( {\n");

    await expect(loadPrcExtensionFactory(filePath)).rejects.toThrow();
  });

  it("loads and activates multiple manifest-declared extension entries", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "multi-entry-extension",
      extensionFile: "alpha.mjs",
      extensionCode: "export default function activate(prc) { prc.commands.register({ id: 'multi.alpha', title: 'Alpha', run: () => 'alpha' }); }\n",
      manifest: {
        name: "multi-entry-extension",
        version: "0.0.0-test",
        piRemoteControl: { extensions: ["./alpha.mjs", "./beta.mjs"] },
      },
    });
    await fs.writeFile(path.join(packageDir, "beta.mjs"), "export default function activate(prc) { prc.commands.register({ id: 'multi.beta', title: 'Beta', run: () => 'beta' }); }\n", "utf8");

    const resolved = await resolvePackageExtensions({ packages: [packageDir] }, { cwd: home.root });
    const host = createPrcExtensionHost();
    await host.activateAll(await loadResolvedExtensionEntries(resolved.extensions));

    expect(resolved.diagnostics).toEqual([]);
    await expect(host.commands.run("multi.alpha")).resolves.toBe("alpha");
    await expect(host.commands.run("multi.beta")).resolves.toBe("beta");
  });
});

async function activateFile(filePath: string) {
  const host = createPrcExtensionHost();
  await host.activate({ id: path.basename(filePath), factory: await loadPrcExtensionFactory(filePath) });
  expect(host.diagnostics).toEqual([]);
  return host;
}

async function writeExtensionModule(name: string, code: string): Promise<string> {
  const home = await makeHome();
  const filePath = path.join(home.root, name);
  await fs.writeFile(filePath, code, "utf8");
  return filePath;
}

async function makeHome(): Promise<TempPrcHome> {
  const home = await createTempPrcHome();
  homes.push(home);
  return home;
}
