import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcAdapter } from "../../src/server/pi/pirpc-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

async function makeFakePiRpcExecutable(root: string): Promise<string> {
  const fakeRpc = path.join(root, "fake-pi-rpc.mjs");
  const sessionFile = path.join(root, "sessions", "fake.jsonl");
  const responseFile = path.join(root, "extension-ui-response.json");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(fakeRpc, `
import { writeFileSync } from "node:fs";
const sessionFile = ${JSON.stringify(sessionFile)};
const responseFile = ${JSON.stringify(responseFile)};
const sessionId = "fake-rpc-session";
let name;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index).replace(/\\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    handle(message);
  }
});
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function state() {
  return { sessionId, sessionFile, sessionName: name, isStreaming: false, isCompacting: false, messageCount: 2, model: { provider: "fake", id: "model" } };
}
function handle(message) {
  if (message.type === "extension_ui_response") { writeFileSync(responseFile, JSON.stringify(message)); return; }
  if (message.type === "get_state") return send({ id: message.id, type: "response", command: "get_state", success: true, data: state() });
  if (message.type === "set_session_name") { name = message.name; return send({ id: message.id, type: "response", command: "set_session_name", success: true }); }
  if (message.type === "get_messages") return send({ id: message.id, type: "response", command: "get_messages", success: true, data: { messages: [{ role: "assistant", content: [{ type: "text", text: "hello from rpc" }] }] } });
  if (message.type === "prompt") {
    send({ id: message.id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    send({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Continue?" });
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    send({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "show_artifact", result: { content: [{ type: "text", text: "displayed" }], details: { piRemoteControlArtifact: { version: 1, kind: "markdown", title: "Report", markdown: "ok" } } }, isError: false });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
    send({ type: "agent_end", messages: [] });
    return;
  }
  send({ id: message.id, type: "response", command: message.type, success: true });
}
`, "utf8");
  const executable = path.join(root, "fake-pi");
  await fs.writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeRpc)}\n`, "utf8");
  await fs.chmod(executable, 0o755);
  return executable;
}

describe("PiRpcAdapter", () => {
  it("creates an RPC-backed session and forwards raw Pi RPC events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-remote-pirpc-test-"));
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    await fs.mkdir(projectRoot, { recursive: true });
    const piCommand = await makeFakePiRpcExecutable(root);
    const registry = new SessionRegistry({
      adapter: new PiRpcAdapter({ piCommand, sessionDir: sessionRoot, artifactExtension: false }),
      pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    });

    const session = await registry.createSession({ cwd: projectRoot, sessionName: "RPC smoke" });
    expect(session.id).toBe("fake-rpc-session");
    await expect(session.handle.getState()).resolves.toMatchObject({ sessionName: "RPC smoke", modelProvider: "fake", model: "model" });

    const events: unknown[] = [];
    registry.subscribe(session.id, (event) => events.push(event));
    await registry.prompt(session.id, "hello");

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent_start" }),
      expect.objectContaining({ type: "extension_ui_request", id: "ui-1", method: "confirm" }),
      expect.objectContaining({ type: "message_update" }),
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: "show_artifact",
        result: expect.objectContaining({
          details: expect.objectContaining({
            piRemoteControlArtifact: expect.objectContaining({ kind: "markdown", title: "Report" }),
          }),
        }),
      }),
      expect.objectContaining({ type: "agent_end" }),
    ]));

    await registry.respondToExtensionUi(session.id, { id: "ui-1", confirmed: true });
    await expect(readEventually(path.join(root, "extension-ui-response.json")))
      .resolves.toContain('"confirmed":true');

    await registry.disposeAll();
  });
});

async function readEventually(file: string): Promise<string> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for file");
}
