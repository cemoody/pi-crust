import { describe, expect, it } from "vitest";
import { createPrcExtensionHost } from "../../src/extensions/registry.js";
import { serializeExtensions } from "../../src/extensions/metadata.js";

describe("pi-crust extension settings section contributions", () => {
  it("registers settings sections with id/title/order/description", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "core.presentations",
      factory: (prc) => {
        prc.settings.registerSection({
          id: "core.presentations.settings",
          title: "Presentations",
          order: 50,
          description: "Template packs scanned for layouts and themes",
        });
      },
    });

    expect(host.diagnostics).toEqual([]);
    const sections = host.settings.list();
    expect(sections).toEqual([
      {
        id: "core.presentations.settings",
        title: "Presentations",
        order: 50,
        description: "Template packs scanned for layouts and themes",
        extensionId: "core.presentations",
      },
    ]);
    expect(host.settings.get("core.presentations.settings")?.title).toBe("Presentations");
  });

  it("sorts settings sections by order then title", async () => {
    const host = createPrcExtensionHost();
    await host.activateAll([
      { id: "ext.a", factory: (prc) => prc.settings.registerSection({ id: "ext.a.cfg", title: "Zulu", order: 10 }) },
      { id: "ext.b", factory: (prc) => prc.settings.registerSection({ id: "ext.b.cfg", title: "Alpha", order: 10 }) },
      { id: "ext.c", factory: (prc) => prc.settings.registerSection({ id: "ext.c.cfg", title: "First", order: 5 }) },
      { id: "ext.d", factory: (prc) => prc.settings.registerSection({ id: "ext.d.cfg", title: "NoOrder" }) },
    ]);

    expect(host.settings.list().map((section) => section.id)).toEqual([
      "ext.d.cfg", // order undefined -> treated as 0, sorts first
      "ext.c.cfg",
      "ext.b.cfg",
      "ext.a.cfg",
    ]);
  });

  it("records a diagnostic and cleans up partial contributions when a duplicate id is registered", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "first",
      factory: (prc) => prc.settings.registerSection({ id: "shared.cfg", title: "First" }),
    });
    await host.activate({
      id: "second",
      factory: (prc) => {
        prc.commands.register({ id: "second.command", title: "Second", run: () => "ok" });
        prc.settings.registerSection({ id: "shared.cfg", title: "Second" });
      },
    });

    expect(host.settings.list().map((section) => section.extensionId)).toEqual(["first"]);
    expect(host.diagnostics).toEqual([
      { extensionId: "second", level: "error", message: "Settings section already registered: shared.cfg" },
    ]);
    // partial contributions from the failed activation are rolled back
    expect(host.commands.get("second.command")).toBeUndefined();
  });

  it("removes contributed settings sections when the extension is disposed", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "core.presentations",
      factory: (prc) => prc.settings.registerSection({ id: "core.presentations.settings", title: "Presentations" }),
    });

    expect(host.settings.get("core.presentations.settings")).toBeDefined();
    await host.dispose();
    expect(host.settings.list()).toEqual([]);
  });

  it("removes a settings section when its disposable is disposed directly", () => {
    const host = createPrcExtensionHost();
    const disposable = host.settings.register("direct", { id: "direct.cfg", title: "Direct" });
    expect(host.settings.get("direct.cfg")?.title).toBe("Direct");
    disposable.dispose();
    expect(host.settings.get("direct.cfg")).toBeUndefined();
  });

  it("exposes contributed settings sections via serializeExtensions including the extension's web module url", async () => {
    const host = createPrcExtensionHost();
    host.registerWebAsset("core.presentations", "/abs/path/to/presentations.web.mjs");
    await host.activate({
      id: "core.presentations",
      factory: (prc) => prc.settings.registerSection({
        id: "core.presentations.settings",
        title: "Presentations",
        order: 50,
      }),
    });

    const serialized = serializeExtensions(host);
    expect(serialized.settings).toEqual([
      expect.objectContaining({
        id: "core.presentations.settings",
        title: "Presentations",
        order: 50,
        extensionId: "core.presentations",
        webModuleUrl: expect.stringContaining("/api/extensions/core.presentations/assets/presentations.web.mjs"),
      }),
    ]);
  });

  it("omits settings sections from serializeExtensions when no extension has contributed any", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "no-settings",
      factory: (prc) => prc.commands.register({ id: "no-settings.cmd", title: "No Settings", run: () => "ok" }),
    });

    const serialized = serializeExtensions(host);
    expect(serialized.settings).toEqual([]);
  });
});
