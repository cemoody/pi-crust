import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapPrcExtensions } from "../../src/extensions/bootstrap.js";
import { serializeExtensions } from "../../src/extensions/metadata.js";
import { writePrcSettings } from "../../src/extensions/packages.js";

const presentationsExtDir = path.dirname(
  createRequire(import.meta.url).resolve("@cemoody/pi-crust-ext-presentations/package.json"),
);

const PRESENTATIONS_EXTENSION_ID = "@cemoody/pi-crust-ext-presentations";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * Contract: the bundled core.presentations extension must own its template-
 * directory Settings UI via `prc.settings.registerSection`, NOT add a sidebar
 * activity, and surface a web module URL so the pi-crust Settings panel can
 * render it. These tests pin the contract from the host side; the extension
 * repo ships the matching implementation + web module.
 */
describe("presentation template settings contribution", () => {
  it("lets core.presentations register a Settings section without adding a sidebar activity", async () => {
    const root = await tempRoot("prc-presentations-settings-section-");
    const result = await bootstrapPrcExtensions({
      configDir: path.join(root, "config"),
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [presentationsExtDir],
    });

    const sections = result.host.settings.list().filter((s) => s.extensionId === PRESENTATIONS_EXTENSION_ID);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toMatch(/.+/);

    const activities = result.host.activity.list().filter((a) => a.extensionId === PRESENTATIONS_EXTENSION_ID);
    expect(activities).toEqual([]);
  });

  it("surfaces the contributed section through serializeExtensions with a webModuleUrl", async () => {
    const root = await tempRoot("prc-presentations-serialized-");
    const result = await bootstrapPrcExtensions({
      configDir: path.join(root, "config"),
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [presentationsExtDir],
    });

    const serialized = serializeExtensions(result.host);
    const contributed = serialized.settings.filter((s) => s.extensionId === PRESENTATIONS_EXTENSION_ID);
    expect(contributed).toHaveLength(1);
    expect(contributed[0]?.webModuleUrl).toMatch(/^\/api\/extensions\/.+\/assets\/.+/);
  });

  it("removes the contributed section when the presentations extension is disabled", async () => {
    const root = await tempRoot("prc-presentations-disabled-section-");
    const configDir = path.join(root, "config");
    await writePrcSettings(configDir, { disabledExtensions: [PRESENTATIONS_EXTENSION_ID] });

    const result = await bootstrapPrcExtensions({
      configDir,
      cwd: root,
      dataDir: path.join(root, "data"),
      bundledPackagePaths: [presentationsExtDir],
    });

    const sections = result.host.settings.list().filter((s) => s.extensionId === PRESENTATIONS_EXTENSION_ID);
    expect(sections).toEqual([]);
    const serialized = serializeExtensions(result.host);
    expect(serialized.settings.filter((s) => s.extensionId === PRESENTATIONS_EXTENSION_ID)).toEqual([]);
  });
});
