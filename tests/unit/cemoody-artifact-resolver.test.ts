import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCemoodyArtifactExtension } from "../../src/server/pi/pirpc-pi-adapter.js";

// Validates the auto-registration plumbing for the bundled
// @cemoody/pi-artifact extension. Mirrors the resolver pattern used for
// pi-crust's own pi-crust-artifacts.ts: a lazy filesystem lookup
// guarded by an env var, with an optional override path for local dev.
//
// The resolver under test accepts an injected `env` and `searchRoots` so
// the tests can be hermetic — without that, the resolver would walk up from
// this file's location and pick up the *real* @cemoody/pi-artifact under
// pi-crust's own node_modules, defeating the test setup.

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-cemoody-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("resolveCemoodyArtifactExtension", () => {
  it("returns undefined when PI_CRUST_DISABLE_CEMOODY_ARTIFACT=1", async () => {
    const result = await resolveCemoodyArtifactExtension({
      env: { PI_CRUST_DISABLE_CEMOODY_ARTIFACT: "1" },
      searchRoots: [tmpRoot],
    });
    expect(result).toBeUndefined();
  });

  it("honors PI_CRUST_CEMOODY_ARTIFACT_PATH override when the file exists", async () => {
    const override = path.join(tmpRoot, "src", "index.ts");
    await fs.mkdir(path.dirname(override), { recursive: true });
    await fs.writeFile(override, "export default () => {};\n");
    const result = await resolveCemoodyArtifactExtension({
      env: { PI_CRUST_CEMOODY_ARTIFACT_PATH: override },
      searchRoots: [tmpRoot],
    });
    expect(result).toBe(path.resolve(override));
  });

  it("ignores a missing PI_CRUST_CEMOODY_ARTIFACT_PATH and falls through to node_modules lookup", async () => {
    const result = await resolveCemoodyArtifactExtension({
      env: { PI_CRUST_CEMOODY_ARTIFACT_PATH: path.join(tmpRoot, "does-not-exist.ts") },
      searchRoots: [tmpRoot],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when Pi settings already install a local pi-artifact", async () => {
    const settingsPath = path.join(tmpRoot, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({ packages: ["npm:pi-web-access", "../../pi-artifact"] }));

    const pkgRoot = path.join(tmpRoot, "node_modules", "@cemoody", "pi-artifact");
    await fs.mkdir(path.join(pkgRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "@cemoody/pi-artifact" }));
    await fs.writeFile(path.join(pkgRoot, "src", "index.ts"), "export default () => {};\n");

    const result = await resolveCemoodyArtifactExtension({ env: {}, searchRoots: [tmpRoot], piSettingsPath: settingsPath });
    expect(result).toBeUndefined();
  });

  it("returns undefined when Pi settings already install npm:@cemoody/pi-artifact", async () => {
    const settingsPath = path.join(tmpRoot, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({ packages: ["npm:@cemoody/pi-artifact"] }));

    const pkgRoot = path.join(tmpRoot, "node_modules", "@cemoody", "pi-artifact");
    await fs.mkdir(path.join(pkgRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "@cemoody/pi-artifact" }));
    await fs.writeFile(path.join(pkgRoot, "src", "index.ts"), "export default () => {};\n");

    const result = await resolveCemoodyArtifactExtension({ env: {}, searchRoots: [tmpRoot], piSettingsPath: settingsPath });
    expect(result).toBeUndefined();
  });

  it("walks up from a search root to find node_modules/@cemoody/pi-artifact and reads pi.extensions[0]", async () => {
    // Construct: tmpRoot/project/sub/deep, with the pi-artifact package
    // installed at tmpRoot/project/node_modules/@cemoody/pi-artifact.
    const projectRoot = path.join(tmpRoot, "project");
    const deepStart = path.join(projectRoot, "sub", "deep");
    await fs.mkdir(deepStart, { recursive: true });
    const pkgRoot = path.join(projectRoot, "node_modules", "@cemoody", "pi-artifact");
    await fs.mkdir(path.join(pkgRoot, "lib"), { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({
      name: "@cemoody/pi-artifact",
      pi: { extensions: ["./lib/entry.ts"] },
    }));
    const entry = path.join(pkgRoot, "lib", "entry.ts");
    await fs.writeFile(entry, "export default () => {};\n");

    const result = await resolveCemoodyArtifactExtension({ env: {}, searchRoots: [deepStart] });
    expect(result).toBe(entry);
  });

  it("falls back to ./src/index.ts when the manifest has no pi.extensions", async () => {
    const pkgRoot = path.join(tmpRoot, "node_modules", "@cemoody", "pi-artifact");
    await fs.mkdir(path.join(pkgRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "@cemoody/pi-artifact" }));
    const entry = path.join(pkgRoot, "src", "index.ts");
    await fs.writeFile(entry, "export default () => {};\n");

    const result = await resolveCemoodyArtifactExtension({ env: {}, searchRoots: [tmpRoot] });
    expect(result).toBe(entry);
  });

  it("returns undefined when the package is installed but the entry file is missing", async () => {
    const pkgRoot = path.join(tmpRoot, "node_modules", "@cemoody", "pi-artifact");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({
      name: "@cemoody/pi-artifact",
      pi: { extensions: ["./src/index.ts"] },
    }));
    // No actual src/index.ts file.
    const result = await resolveCemoodyArtifactExtension({ env: {}, searchRoots: [tmpRoot] });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no @cemoody/pi-artifact is anywhere on the search path", async () => {
    const result = await resolveCemoodyArtifactExtension({ env: {}, searchRoots: [tmpRoot] });
    expect(result).toBeUndefined();
  });
});
