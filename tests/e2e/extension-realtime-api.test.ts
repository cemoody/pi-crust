/**
 * TDD contract for `ctx.server.realtime` — the extension-API bridge that lets a
 * server-side extension register Socket.IO event handlers on the SAME gateway
 * core already runs (the one that serves `session:subscribe`). This is what an
 * extracted Terminal extension (`pi-crust-ext-terminal`) needs so its `pty:*`
 * stream lives in the extension, not in core.
 *
 * Surface under test:
 *   ctx.server.realtime.onConnection((conn) => {
 *     conn.on("ext:ping", (payload, ack) => { conn.emit("ext:pong", ...); ack?.(...); });
 *     return () => { ...cleanup on disconnect... };
 *   });
 *
 * Guarantees:
 *  - the handler fires once PER new connection (per-socket scope, like core);
 *  - `conn.emit` reaches only that connection;
 *  - acks work;
 *  - the disposer returned by onConnection runs on disconnect (no leaks).
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PrcExtensionFactory } from "../../src/extensions/api.js";
import { createPrcExtensionHost } from "../../src/extensions/registry.js";
import { createHttpApiServer } from "../../src/server/http-api-server.js";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { createTempPrcHome, type TempPrcHome } from "../helpers/temp-pi-crust-home.js";

const servers: http.Server[] = [];
const homes: TempPrcHome[] = [];
const clients: any[] = [];

afterEach(async () => {
  for (const socket of clients.splice(0)) { try { socket.disconnect(); socket.close(); } catch { /* ignore */ } }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("extension realtime API (ctx.server.realtime)", () => {
  it("delivers a client event to a handler registered by an extension and echoes back to only that connection", async () => {
    const baseUrl = await startExtensionServer("rt-test", (prc) => {
      prc.server.realtime.onConnection((conn) => {
        conn.on("ext:ping", (payload: any, ack?: (response: unknown) => void) => {
          conn.emit("ext:pong", { from: prc.extensionId, got: payload?.n });
          ack?.({ ok: true, doubled: (payload?.n ?? 0) * 2 });
        });
      });
    });

    const a = await connectRaw(baseUrl);
    const b = await connectRaw(baseUrl);

    const ack = await a.emitWithAck("ext:ping", { n: 21 });
    expect(ack).toEqual({ ok: true, doubled: 42 });

    const pong = await a.next("ext:pong");
    expect(pong).toEqual({ from: "rt-test", got: 21 });

    // The echo went ONLY to connection a; b must not have received a pong.
    expect(await b.none("ext:pong", 150)).toBe(true);
  });

  it("invokes the connection handler once per connection and runs its disposer on disconnect", async () => {
    let opened = 0;
    let closed = 0;
    const baseUrl = await startExtensionServer("rt-life", (prc) => {
      prc.server.realtime.onConnection(() => {
        opened += 1;
        return () => { closed += 1; };
      });
    });

    const a = await connectRaw(baseUrl);
    const b = await connectRaw(baseUrl);
    await waitFor(() => opened === 2);
    expect(opened).toBe(2);
    expect(closed).toBe(0);

    a.disconnect();
    await waitFor(() => closed === 1);
    expect(closed).toBe(1);

    b.disconnect();
    await waitFor(() => closed === 2);
    expect(closed).toBe(2);
  });

  it("picks up a handler registered AFTER the gateway mounted (runtime install via Settings)", async () => {
    // Regression for the `pty:open ack timeout` bug: the gateway used to read
    // extension connection-handlers ONCE at boot. An extension installed at
    // runtime (its host swapped into extensionRuntime.current by reload())
    // then never got its handlers invoked, so its realtime protocol silently
    // timed out until a restart. The gateway must resolve handlers LIVE.
    const home = await createTempPrcHome();
    homes.push(home);

    // Host BEFORE install: no extension realtime handlers.
    const emptyHost = createPrcExtensionHost();
    // Host AFTER install: an extension that handles ext:ping.
    const installedHost = createPrcExtensionHost();
    await installedHost.activate({
      id: "rt-runtime",
      factory: (prc) => {
        prc.server.realtime.onConnection((conn) => {
          conn.on("ext:ping", (payload: any, ack?: (response: unknown) => void) => {
            ack?.({ ok: true, doubled: (payload?.n ?? 0) * 2 });
          });
        });
      },
    });

    // A minimal mutable runtime whose `current` we can swap, mimicking reload().
    let current = emptyHost;
    const extensionRuntime = {
      get current() { return current; },
      configDir: home.configDir,
      cwd: home.projectRoot,
    } as unknown as import("../../src/extensions/runtime.js").PrcExtensionRuntime;

    const registry = new SessionRegistry({
      adapter: new MockPiAdapter({ sessionRoot: home.sessionRoot }),
      pathPolicy: new PathPolicy({ allowedProjectRoots: [home.projectRoot], allowedSessionRoots: [home.sessionRoot] }),
    });
    const server = createHttpApiServer({
      registry,
      adapterKind: "test",
      projectRoot: home.projectRoot,
      sessionRoot: home.sessionRoot,
      defaultCwd: home.projectRoot,
      extensionRuntime,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Expected TCP address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // BEFORE install: a connection's ext:ping is unhandled -> ack never comes.
    const before = await connectRaw(baseUrl);
    await expect(before.emitWithAck("ext:ping", { n: 21 })).rejects.toThrow(/ack timeout/);

    // Simulate the runtime install: swap the active host.
    current = installedHost;

    // A NEW connection (opened after install) MUST get the handler.
    const after = await connectRaw(baseUrl);
    const ack = await after.emitWithAck("ext:ping", { n: 21 });
    expect(ack).toEqual({ ok: true, doubled: 42 });
  });
});

async function startExtensionServer(extensionId: string, factory: PrcExtensionFactory): Promise<string> {
  const home = await createTempPrcHome();
  homes.push(home);
  const extensions = createPrcExtensionHost();
  await extensions.activate({ id: extensionId, factory });
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot: home.sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [home.projectRoot], allowedSessionRoots: [home.sessionRoot] }),
  });
  const server = createHttpApiServer({
    registry,
    adapterKind: "test",
    projectRoot: home.projectRoot,
    sessionRoot: home.sessionRoot,
    defaultCwd: home.projectRoot,
    extensions,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function connectRaw(baseUrl: string) {
  const { io } = (await import("socket.io-client")) as any;
  const socket = io(baseUrl, { path: "/socket.io/", transports: ["websocket"], reconnection: false, timeout: 1_000 });
  clients.push(socket);
  const inbox = new Map<string, any[]>();
  const push = (event: string, value: any) => { (inbox.get(event) ?? inbox.set(event, []).get(event)!).push(value); };
  socket.onAny((event: string, value: any) => push(event, value));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 1_500);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", (e: unknown) => { clearTimeout(timer); reject(e); });
  });
  return {
    socket,
    emitWithAck: (event: string, payload: unknown) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 1_000);
      socket.emit(event, payload, (ack: unknown) => { clearTimeout(timer); resolve(ack); });
    }),
    async next(event: string, timeoutMs = 1_500) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const list = inbox.get(event);
        if (list && list.length > 0) return list.shift();
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${event}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async none(event: string, timeoutMs: number) {
      await new Promise((r) => setTimeout(r, timeoutMs));
      return (inbox.get(event)?.length ?? 0) === 0;
    },
    disconnect() { try { socket.disconnect(); } catch { /* ignore */ } },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
