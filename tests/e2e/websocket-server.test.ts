import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { createWebSocketServer } from "../../src/server/protocol/websocket-server.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { PROTOCOL_VERSION } from "../../src/shared/version.js";

async function makeServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-ws-test-"));
  const projectRoot = path.join(root, "projects");
  const project = path.join(projectRoot, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(project, { recursive: true });
  const registry = new SessionRegistry({
    adapter: new MockPiAdapter({ sessionRoot }),
    pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
  });
  const httpServer = http.createServer();
  const remoteServer = createWebSocketServer({ registry, server: httpServer });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return { project, remoteServer, url: `ws://127.0.0.1:${address.port}` };
}

describe("websocket server", () => {
  it("accepts a connection, sends hello, and creates a session", async () => {
    const { project, remoteServer, url } = await makeServer();
    const socket = new WebSocket(url);
    const messages: any[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(socket, "open");
    await waitFor(() => messages.length >= 1);
    expect(messages[0]).toMatchObject({ type: "hello", protocolVersion: PROTOCOL_VERSION });

    socket.send(JSON.stringify({
      id: "new-1",
      type: "client_op",
      protocolVersion: PROTOCOL_VERSION,
      op: { op: "new_session", cwd: project },
    }));

    await waitFor(() => messages.some((message) => message.type === "response" && message.id === "new-1"));
    expect(messages.find((message) => message.id === "new-1")).toMatchObject({ type: "response", ok: true });

    socket.close();
    await remoteServer.close();
  });
});

async function once(target: WebSocket, event: string): Promise<void> {
  await new Promise<void>((resolve) => target.once(event, () => resolve()));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
