import { describe, expect, it } from "vitest";
import { createPrcExtensionHost } from "../../src/extensions/registry.js";
import { createPrcExtensionHarness } from "../helpers/extension-harness.js";

describe("PRC extension registry harness", () => {
  it("activates inline extension factories and runs registered commands", async () => {
    const harness = await createPrcExtensionHarness({
      extensions: [{
        id: "test.extension",
        factory: (prc) => {
          prc.commands.register({ id: "test.hello", title: "Hello", slashName: "hello", run: (input) => ({ input, ok: true }) });
        },
      }],
    });
    try {
      expect(harness.extensions.diagnostics).toEqual([]);
      expect(harness.extensions.commands.list().map((command) => command.invocationName)).toEqual(["test.hello"]);
      expect(harness.extensions.commands.getSlashCommand("hello")?.id).toBe("test.hello");
      await expect(harness.extensions.commands.run("test.hello", "world")).resolves.toEqual({ input: "world", ok: true });
    } finally {
      await harness.cleanup();
    }
  });

  it("suffixes duplicate command invocation names", async () => {
    const host = createPrcExtensionHost();
    await host.activateAll([
      { id: "alpha", factory: (prc) => prc.commands.register({ id: "shared", title: "Alpha", run: () => "alpha" }) },
      { id: "beta", factory: (prc) => prc.commands.register({ id: "shared", title: "Beta", run: () => "beta" }) },
    ]);

    expect(host.commands.list().map((command) => command.invocationName)).toEqual(["shared", "shared:1"]);
    await expect(host.commands.run("shared")).resolves.toBe("alpha");
    await expect(host.commands.run("shared:1")).resolves.toBe("beta");
  });

  it("documents precedence by activation order: explicit, project, global, then built-in", async () => {
    const host = createPrcExtensionHost();
    await host.activateAll([
      { id: "explicit", factory: (prc) => prc.commands.register({ id: "shared", title: "Explicit", run: () => "explicit" }) },
      { id: "project", factory: (prc) => prc.commands.register({ id: "shared", title: "Project", run: () => "project" }) },
      { id: "global", factory: (prc) => prc.commands.register({ id: "shared", title: "Global", run: () => "global" }) },
      { id: "builtin", factory: (prc) => prc.commands.register({ id: "shared", title: "Built-in", run: () => "builtin" }) },
    ]);

    expect(host.commands.list().map((command) => `${command.invocationName}:${command.extensionId}`)).toEqual([
      "shared:explicit",
      "shared:1:project",
      "shared:2:global",
      "shared:3:builtin",
    ]);
    await expect(host.commands.run("shared")).resolves.toBe("explicit");
  });

  it("keeps the first command for duplicate slash command names", async () => {
    const host = createPrcExtensionHost();
    await host.activateAll([
      { id: "alpha", factory: (prc) => prc.commands.register({ id: "alpha.fork", title: "Alpha Fork", slashName: "fork", run: () => "alpha" }) },
      { id: "beta", factory: (prc) => prc.commands.register({ id: "beta.fork", title: "Beta Fork", slashName: "fork", run: () => "beta" }) },
    ]);

    expect(host.commands.getSlashCommand("fork")?.id).toBe("alpha.fork");
    expect(host.commands.list().map((command) => command.id)).toEqual(["alpha.fork", "beta.fork"]);
  });

  it("removes slash metadata when a command disposable is disposed", () => {
    const host = createPrcExtensionHost();
    const disposable = host.commands.register("direct", { id: "direct.fork", title: "Fork", slashName: "fork", run: () => "fork" });

    expect(host.commands.get("direct.fork")?.id).toBe("direct.fork");
    expect(host.commands.getSlashCommand("fork")?.id).toBe("direct.fork");

    disposable.dispose();

    expect(host.commands.get("direct.fork")).toBeUndefined();
    expect(host.commands.getSlashCommand("fork")).toBeUndefined();
  });

  it("does not rebind duplicate slash command names when the first owner is disposed", async () => {
    const host = createPrcExtensionHost();
    let firstDisposable: { dispose(): void } | undefined;
    await host.activateAll([
      { id: "alpha", factory: (prc) => { firstDisposable = prc.commands.register({ id: "alpha.fork", title: "Alpha Fork", slashName: "fork", run: () => "alpha" }); } },
      { id: "beta", factory: (prc) => prc.commands.register({ id: "beta.fork", title: "Beta Fork", slashName: "fork", run: () => "beta" }) },
    ]);

    firstDisposable?.dispose();

    expect(host.commands.get("beta.fork")?.id).toBe("beta.fork");
    expect(host.commands.getSlashCommand("fork")).toBeUndefined();
  });

  it("registers activity views and removes contributions on dispose", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "panel",
      factory: (prc) => {
        prc.activity.registerView({ id: "panel.view", title: "Panel", order: 10, render: "Hello from test extension" });
      },
    });

    expect(host.activity.get("panel.view")?.title).toBe("Panel");
    await host.dispose();
    expect(host.activity.list()).toEqual([]);
  });

  it("activates built-in extensions through the same host path as external extensions", async () => {
    const host = createPrcExtensionHost();
    await host.activateAll([
      { id: "core.schedule", factory: (prc) => {
        prc.commands.register({ id: "core.schedule.open", title: "Open Schedule", run: () => "schedule" });
        prc.activity.registerView({ id: "core.schedule.view", title: "Schedule" });
      } },
      { id: "external.test", factory: (prc) => {
        prc.commands.register({ id: "external.test.open", title: "Open External", run: () => "external" });
        prc.activity.registerView({ id: "external.test.view", title: "External" });
      } },
    ]);

    expect(host.commands.list().map((command) => command.extensionId)).toEqual(["core.schedule", "external.test"]);
    expect(host.activity.list().map((view) => view.extensionId)).toEqual(["external.test", "core.schedule"]);
    await expect(host.commands.run("core.schedule.open")).resolves.toBe("schedule");
    await expect(host.commands.run("external.test.open")).resolves.toBe("external");
  });

  it("disposes host-tracked commands, slash metadata, activity views, and routes", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "cleanup",
      factory: (prc) => {
        prc.commands.register({ id: "cleanup.command", title: "Cleanup", slashName: "cleanup", run: () => "ok" });
        prc.activity.registerView({ id: "cleanup.view", title: "Cleanup" });
        prc.server.routes.get("/cleanup", () => ({ ok: true }));
      },
    });

    expect(host.commands.get("cleanup.command")).toBeDefined();
    expect(host.commands.getSlashCommand("cleanup")).toBeDefined();
    expect(host.activity.get("cleanup.view")).toBeDefined();
    expect(await host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/extensions/cleanup/cleanup"))).toEqual({ status: 200, body: { ok: true } });

    await host.dispose();

    expect(host.commands.get("cleanup.command")).toBeUndefined();
    expect(host.commands.getSlashCommand("cleanup")).toBeUndefined();
    expect(host.activity.get("cleanup.view")).toBeUndefined();
    expect(await host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/extensions/cleanup/cleanup"))).toBeUndefined();
  });

  it("disposes returned disposables once and makes host disposal idempotent", async () => {
    const host = createPrcExtensionHost();
    const calls: string[] = [];
    await host.activate({
      id: "returned-disposable",
      factory: (prc) => {
        prc.commands.register({ id: "returned.command", title: "Returned", run: () => "ok" });
        return { dispose: () => { calls.push("returned"); } };
      },
    });

    await host.dispose();
    await host.dispose();

    expect(calls).toEqual(["returned"]);
    expect(host.commands.get("returned.command")).toBeUndefined();
  });

  it("cleans up partial contributions when activation fails", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "partial",
      factory: (prc) => {
        prc.commands.register({ id: "partial.command", title: "Partial", run: () => "bad" });
        prc.activity.registerView({ id: "partial.view", title: "Partial" });
        throw new Error("activation failed");
      },
    });

    expect(host.commands.get("partial.command")).toBeUndefined();
    expect(host.activity.get("partial.view")).toBeUndefined();
    expect(host.diagnostics).toEqual([{ extensionId: "partial", level: "error", message: "activation failed" }]);
  });

  it("cleans up partial server routes when duplicate registration fails", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "route-dup",
      factory: (prc) => {
        prc.server.routes.get("/ping", () => ({ first: true }));
        prc.server.routes.get("/ping", () => ({ second: true }));
      },
    });

    expect(host.diagnostics[0]?.message).toBe("Server route already registered: GET route-dup/ping");
    const response = await host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/extensions/route-dup/ping"));
    expect(response).toBeUndefined();
  });

  it("isolates activation errors and keeps earlier contributions", async () => {
    const host = createPrcExtensionHost();
    await host.activateAll([
      { id: "good", factory: (prc) => prc.commands.register({ id: "good", title: "Good", run: () => "ok" }) },
      { id: "bad", factory: () => { throw new Error("boom"); } },
    ]);

    expect(host.commands.get("good")?.title).toBe("Good");
    expect(host.diagnostics).toEqual([{ extensionId: "bad", level: "error", message: "boom" }]);
  });

  it("dispatches built-in API compatibility routes outside the extension namespace", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "core.schedule",
      factory: (prc) => {
        prc.server.api.get("/api/cron/:id", (request) => ({ id: request.params.id, ok: true }));
      },
    });

    const response = await host.serverRoutes.dispatch(ReadableRequest.empty("GET") as never, new URL("http://localhost/api/cron/job-1"));

    expect(response).toEqual({ status: 200, body: { id: "job-1", ok: true } });
  });

  it("dispatches extension server routes with path params and JSON bodies", async () => {
    const host = createPrcExtensionHost();
    await host.activate({
      id: "server-test",
      factory: (prc) => {
        prc.server.routes.post("/echo/:name", async (request) => ({
          status: 201,
          body: { name: request.params.name, body: await request.json() },
        }));
      },
    });

    const req = ReadableRequest.fromJson("POST", { value: 42 });
    const response = await host.serverRoutes.dispatch(req as never, new URL("http://localhost/api/extensions/server-test/echo/alice"));
    expect(response).toEqual({ status: 201, body: { name: "alice", body: { value: 42 } } });
  });
});

class ReadableRequest {
  method: string;
  headers: Record<string, string> = {};

  private constructor(method: string, private readonly chunks: readonly Buffer[]) {
    this.method = method;
  }

  static fromJson(method: string, body: unknown): ReadableRequest {
    return new ReadableRequest(method, [Buffer.from(JSON.stringify(body))]);
  }

  static empty(method: string): ReadableRequest {
    return new ReadableRequest(method, []);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    yield* this.chunks;
  }
}
