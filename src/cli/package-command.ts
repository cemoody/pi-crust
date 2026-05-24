#!/usr/bin/env node
// Must run BEFORE any env-var reads. Mirrors legacy PI_REMOTE_* -> PI_CRUST_*.
import "../shared/env-compat-auto.js";
import { installExtensionPackage, removeExtensionPackage } from "../extensions/packages.js";
import { defaultPrcConfigDir } from "../extensions/bootstrap.js";

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, source, ...rest] = argv;
  const configDir = defaultPrcConfigDir(env);
  if (command === "install") {
    if (source === "--help" || source === "-h") {
      printInstallHelp();
      return 0;
    }
    const unknown = [source, ...rest].find((arg) => arg?.startsWith("-") && arg !== "--");
    if (unknown) {
      console.error(`Unknown install option: ${unknown}`);
      printInstallHelp();
      return 2;
    }
    if (!source) {
      console.error("Missing extension package source.");
      printInstallHelp();
      return 2;
    }
    const settings = await installExtensionPackage(source, { configDir, cwd: process.cwd() });
    console.log(`Installed pi-crust extension package: ${source}`);
    console.log(`Settings: ${configDir}/settings.json`);
    console.log(`Packages: ${settings.packages?.length ?? 0}`);
    return 0;
  }
  if (command === "remove" || command === "uninstall") {
    if (!source || source === "--help" || source === "-h") {
      printRemoveHelp();
      return source ? 0 : 2;
    }
    const settings = await removeExtensionPackage(source, { configDir, cwd: process.cwd() });
    console.log(`Removed pi-crust extension package: ${source}`);
    console.log(`Settings: ${configDir}/settings.json`);
    console.log(`Packages: ${settings.packages?.length ?? 0}`);
    return 0;
  }
  console.error(`Unknown package command: ${command ?? "(none)"}`);
  printInstallHelp();
  return 2;
}

function printInstallHelp(): void {
  console.log(`Usage: pi-crust install <local-extension-package>\n\nInstalls a local pi-crust extension package into PI_CRUST_CONFIG_DIR/settings.json.`);
}

function printRemoveHelp(): void {
  console.log(`Usage: pi-crust remove <local-extension-package>\n\nRemoves a local pi-crust extension package from PI_CRUST_CONFIG_DIR/settings.json.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
