import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/package-command.js";
import { readPrcSettings } from "../../src/extensions/packages.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";
import { writeLocalExtensionPackage } from "../helpers/local-extension-package.js";

let homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("pi-crust package command", () => {
  it("installs and removes local extension packages using PI_CRUST_CONFIG_DIR", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.configDir, { name: "cli-extension" });

    await expect(main(["install", packageDir], home.env)).resolves.toBe(0);
    await expect(readPrcSettings(home.configDir)).resolves.toEqual({ packages: ["cli-extension"] });

    await expect(main(["remove", "cli-extension/"], home.env)).resolves.toBe(0);
    await expect(readPrcSettings(home.configDir)).resolves.toEqual({ packages: [] });
  });

  it("returns friendly non-zero status for missing install source", async () => {
    const home = await makeHome();

    await expect(main(["install"], home.env)).resolves.toBe(2);
  });

  it("resolves relative install paths from the current working directory", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.projectRoot, { name: "relative-cli-extension" });

    const cwd = process.cwd();
    try {
      process.chdir(home.projectRoot);
      await expect(main(["install", path.relative(home.projectRoot, packageDir)], home.env)).resolves.toBe(0);
    } finally {
      process.chdir(cwd);
    }

    await expect(readPrcSettings(home.configDir)).resolves.toEqual({ packages: [path.relative(home.configDir, packageDir)] });
  });
});

async function makeHome(): Promise<TempPrcHome> {
  const home = await createTempPrcHome();
  homes.push(home);
  return home;
}
