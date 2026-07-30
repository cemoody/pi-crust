import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const fullPackageDir = "packages/pi-crust-full";
const fullPackagePath = path.join(fullPackageDir, "package.json");

/**
 * semantic-release plugin for the companion meta-package.
 *
 * The package must share pi-crust's release version and depend on that exact
 * published pi-crust version. We update its staged manifest during prepare,
 * then publish it *after* @semantic-release/npm has published pi-crust.
 * No release commit is needed, which keeps protected main from blocking the
 * release workflow merely because semantic-release tries to write a changelog.
 */
export async function prepare(pluginConfig, context) {
  const manifestPath = path.join(context.cwd, fullPackagePath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const version = context.nextRelease.version;
  manifest.version = version;
  manifest.dependencies = { ...manifest.dependencies, "pi-crust": version };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  context.logger.log(`Prepared ${manifest.name}@${version} with pi-crust@${version}`);
}

export async function publish(pluginConfig, context) {
  const packageDir = path.join(context.cwd, fullPackageDir);
  const { stdout, stderr } = await execFileAsync(
    "npm",
    ["publish", packageDir, "--access", "public", "--provenance"],
    { cwd: context.cwd, env: process.env },
  );
  if (stdout) context.logger.log(stdout.trim());
  if (stderr) context.logger.log(stderr.trim());
  return {
    name: "pi-crust-full",
    url: `https://www.npmjs.com/package/pi-crust-full/v/${context.nextRelease.version}`,
  };
}
