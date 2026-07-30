#!/usr/bin/env node
/**
 * Publishes the pi-crust-full companion package at an exact core version.
 * This recovery command exists for the rare partial-release case where the
 * core package has reached npm but the meta-package did not. It validates that
 * pi-crust is already public, stages matching metadata in a temporary copy,
 * and publishes via the workflow's OIDC identity without changing Git state.
 */
import { execFile } from "node:child_process";
import { mkdtemp, cp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/publish-pi-crust-full.mjs <semver-version>");
}

const root = process.cwd();
const source = path.join(root, "packages", "pi-crust-full");
const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-crust-full-publish-"));
const packageDir = path.join(temporary, "pi-crust-full");

try {
  await execFileAsync("npm", ["view", `pi-crust@${version}`, "version", "--json"], { cwd: root });
  await cp(source, packageDir, { recursive: true });
  const manifestPath = path.join(packageDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  manifest.dependencies = { ...manifest.dependencies, "pi-crust": version };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await execFileAsync("npm", ["publish", packageDir, "--access", "public", "--provenance"], { cwd: root, stdio: "inherit" });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
