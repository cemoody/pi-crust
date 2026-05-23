import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackageExtensions, resolveSinglePackageExtensions } from "../../src/extensions/packages.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";
import { writeLocalExtensionPackage } from "../helpers/local-extension-package.js";

let homes: TempPrcHome[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("pi-crust extension package resolver", () => {
  it("returns empty results when no package sources are configured", async () => {
    const home = await makeHome();

    const result = await resolvePackageExtensions({}, { cwd: home.root });

    expect(result).toEqual({ extensions: [], webExtensions: [], diagnostics: [] });
  });

  it("honors the noExtensions option before resolving configured packages", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, { name: "disabled-package" });

    const result = await resolvePackageExtensions({ packages: [packageDir] }, { cwd: home.root, noExtensions: true });

    expect(result).toEqual({ extensions: [], webExtensions: [], diagnostics: [] });
  });

  it("resolves a package.json piRemoteControl.extension entry", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, { extensionFile: "src/extension.mjs" });

    const entries = await resolveSinglePackageExtensions(packageDir);

    expect(entries).toEqual([path.join(packageDir, "src", "extension.mjs")]);
  });

  it("reports diagnostics for missing explicit manifest paths", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "missing-explicit-package");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "missing-explicit-package",
      piRemoteControl: { extension: "./missing.mjs" },
    }));

    const result = await resolvePackageExtensions({ packages: [packageDir] }, { cwd: home.root });

    expect(result.extensions).toEqual([]);
    expect(result.diagnostics).toEqual([{ source: packageDir, level: "error", message: `Extension path does not exist: ${path.join(packageDir, "missing.mjs")}` }]);
  });

  it("allows empty glob manifest matches without diagnostics", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "empty-glob-package");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "empty-glob-package",
      piRemoteControl: { extensions: ["extensions/*.mjs"] },
    }));

    const result = await resolvePackageExtensions({ packages: [packageDir] }, { cwd: home.root });

    expect(result).toEqual({ extensions: [], webExtensions: [], diagnostics: [] });
  });

  it("uses package-root manifest entries instead of fallback index files", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "root-manifest-package");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "index.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "actual.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "root-manifest-package",
      piRemoteControl: { extension: "./actual.mjs" },
    }));

    const entries = await resolveSinglePackageExtensions(packageDir);

    expect(entries).toEqual([path.join(packageDir, "actual.mjs")]);
  });

  it("falls back to index when package.json has no piRemoteControl extension field", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "plain-package");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "index.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "plain-package" }));

    const entries = await resolveSinglePackageExtensions(packageDir);

    expect(entries).toEqual([path.join(packageDir, "index.mjs")]);
  });

  it("ignores non-extension files", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "non-extension-package");
    await fs.mkdir(path.join(packageDir, "extensions"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "README.md"), "docs\n");
    await fs.writeFile(path.join(packageDir, "extensions", "notes.md"), "notes\n");

    const entries = await resolveSinglePackageExtensions(packageDir);

    expect(entries).toEqual([]);
  });

  it("resolves package extension include/exclude patterns", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "pattern-package");
    await fs.mkdir(path.join(packageDir, "extensions", "nested"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "extensions", "alpha.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "beta.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "nested", "gamma.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "pattern-package",
      piRemoteControl: { extensions: ["extensions/**/*.mjs", "!extensions/beta.mjs"] },
    }));

    const entries = await resolveSinglePackageExtensions(packageDir);

    expect(entries.map((entry) => path.relative(packageDir, entry).split(path.sep).join("/"))).toEqual([
      "extensions/alpha.mjs",
      "extensions/nested/gamma.mjs",
    ]);
  });

  it("auto-discovers extension directories using Pi-like one-level semantics", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "auto-package");
    await fs.mkdir(path.join(packageDir, "extensions", "with-index"), { recursive: true });
    await fs.mkdir(path.join(packageDir, "extensions", "without-index"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "extensions", "direct.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "with-index", "index.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "with-index", "helper.mjs"), "export const helper = true;\n");
    await fs.writeFile(path.join(packageDir, "extensions", "without-index", "helper.mjs"), "export const helper = true;\n");

    const entries = await resolveSinglePackageExtensions(packageDir);

    expect(entries.map((entry) => path.relative(packageDir, entry).split(path.sep).join("/"))).toEqual([
      "extensions/direct.mjs",
      "extensions/with-index/index.mjs",
    ]);
  });

  it("uses subdirectory package manifests and lets them take precedence over index files", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "subdir-manifest-package");
    const subdir = path.join(packageDir, "extensions", "panel");
    await fs.mkdir(subdir, { recursive: true });
    await fs.writeFile(path.join(subdir, "index.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(subdir, "actual.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(subdir, "package.json"), JSON.stringify({
      name: "panel",
      piRemoteControl: { extension: "./actual.mjs" },
    }));

    const entries = await resolveSinglePackageExtensions(packageDir);

    expect(entries).toEqual([path.join(subdir, "actual.mjs")]);
  });

  it("layers package setting filters on top of manifest filters", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "layered-package");
    await fs.mkdir(path.join(packageDir, "extensions"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "extensions", "foo.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "bar.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "baz.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "layered-package",
      piRemoteControl: { extensions: ["extensions/*.mjs", "!extensions/baz.mjs"] },
    }));

    const result = await resolvePackageExtensions({ packages: [{ source: packageDir, extensions: ["!extensions/bar.mjs"] }] }, { cwd: home.root });

    expect(result.extensions.map((entry) => path.relative(packageDir, entry.path).split(path.sep).join("/"))).toEqual(["extensions/foo.mjs"]);
  });

  it("supports force include and force exclude patterns", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "force-package");
    await fs.mkdir(path.join(packageDir, "extensions"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "extensions", "alpha.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "beta.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "gamma.mjs"), "export default function() {}\n");

    const entries = await resolveSinglePackageExtensions(packageDir, ["extensions/*.mjs", "!extensions/*.mjs", "+extensions/beta.mjs", "-extensions/gamma.mjs"]);

    expect(entries.map((entry) => path.relative(packageDir, entry).split(path.sep).join("/"))).toEqual(["extensions/beta.mjs"]);
  });

  it("dedupes the same local package in global and project settings with project scope winning", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, { name: "shared-package" });

    const result = await resolvePackageExtensions({ packages: [packageDir], projectPackages: [packageDir] }, { cwd: home.root });

    expect(result.diagnostics).toEqual([]);
    expect(result.extensions).toEqual([{ packageSource: packageDir, path: path.join(packageDir, "index.mjs"), scope: "project" }]);
  });

  it("directory manifest patterns discover extension-style entries without helper modules", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "directory-pattern-package");
    await fs.mkdir(path.join(packageDir, "extensions", "feature"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "extensions", "direct.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "feature", "index.mjs"), "export default function() {}\n");
    await fs.writeFile(path.join(packageDir, "extensions", "feature", "helper.mjs"), "export const helper = true;\n");
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "directory-pattern-package",
      piRemoteControl: { extensions: ["extensions"] },
    }));

    const entries = await resolveSinglePackageExtensions(packageDir);

    expect(entries.map((entry) => path.relative(packageDir, entry).split(path.sep).join("/"))).toEqual([
      "extensions/direct.mjs",
      "extensions/feature/index.mjs",
    ]);
  });

  it("dedupes symlinked package paths by real path", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, { name: "real-package" });
    const symlinkPath = path.join(home.root, "linked-package");
    await fs.symlink(packageDir, symlinkPath, "dir");

    const result = await resolvePackageExtensions({ packages: [packageDir], projectPackages: [symlinkPath] }, { cwd: home.root });

    expect(result.diagnostics).toEqual([]);
    expect(result.extensions).toEqual([{ packageSource: symlinkPath, path: path.join(symlinkPath, "index.mjs"), scope: "project" }]);
  });

  it("force exclude wins over force include for the same file", async () => {
    const home = await makeHome();
    const packageDir = path.join(home.root, "force-order-package");
    await fs.mkdir(path.join(packageDir, "extensions"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "extensions", "alpha.mjs"), "export default function() {}\n");

    const entries = await resolveSinglePackageExtensions(packageDir, ["!extensions/*.mjs", "+extensions/alpha.mjs", "-extensions/alpha.mjs"]);

    expect(entries).toEqual([]);
  });

  it("resolves package web extension entries from the manifest", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.root, {
      name: "web-extension-package",
      extensionFile: "server.mjs",
      manifest: {
        name: "web-extension-package",
        version: "0.0.0-test",
        piRemoteControl: { extension: "./server.mjs", web: "./web.mjs" },
      },
    });
    await fs.writeFile(path.join(packageDir, "web.mjs"), "export default function Web() {}\n");

    const result = await resolvePackageExtensions({ packages: [packageDir] }, { cwd: home.root });

    expect(result.diagnostics).toEqual([]);
    expect(result.webExtensions).toEqual([{ packageSource: packageDir, path: path.join(packageDir, "web.mjs"), scope: "global" }]);
  });

  it("resolves installed package settings using the supplied cwd", async () => {
    const home = await makeHome();
    const packageDir = await writeLocalExtensionPackage(home.projectRoot, { name: "installed-extension" });

    const result = await resolvePackageExtensions({ packages: ["installed-extension"] }, { cwd: home.projectRoot });

    expect(result.diagnostics).toEqual([]);
    expect(result.extensions).toEqual([{ packageSource: packageDir, path: path.join(packageDir, "index.mjs"), scope: "global" }]);
  });

  it("returns diagnostics for missing package sources", async () => {
    const home = await makeHome();

    const result = await resolvePackageExtensions({ packages: ["missing"] }, { cwd: home.projectRoot });

    expect(result.extensions).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("ENOENT");
  });
});

async function makeHome(): Promise<TempPrcHome> {
  const home = await createTempPrcHome();
  homes.push(home);
  return home;
}
