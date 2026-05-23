import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toDashboardMessages } from "../../src/server/http-api-server.js";
import { PiRpcAdapter, toSessionMessages } from "../../src/server/pi/pirpc-pi-adapter.js";
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
  if (message.type === "get_session_stats") return send({ id: message.id, type: "response", command: "get_session_stats", success: true, data: {
    sessionFile,
    sessionId,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 4,
    tokens: { input: 12345, output: 6789, cacheRead: 22222, cacheWrite: 3333, total: 44689 },
    cost: 0.9876,
    contextUsage: { tokens: 42424, contextWindow: 1000000, percent: 42 },
  } });
  if (message.type === "set_session_name") { name = message.name; return send({ id: message.id, type: "response", command: "set_session_name", success: true }); }
  if (message.type === "get_messages") return send({ id: message.id, type: "response", command: "get_messages", success: true, data: { messages: [
    { role: "assistant", timestamp: 1000, content: [
      { type: "text", text: "hello from rpc" },
      { type: "toolCall", id: "call_hist", name: "bash", arguments: { command: "npm test" } }
    ] },
    { role: "toolResult", timestamp: 1001, toolCallId: "call_hist", isError: false, content: [{ type: "text", text: "> pi-crust@0.0.0 test\\nPASS tests/unit/foo.test.ts" }] },
    { role: "custom", timestamp: 1002, customType: "artifact", content: "Small bar chart (Vega-Lite spec, 170 B)", display: true, details: { version: 1, artifactGroupId: "abc123", caption: "Small bar chart", artifacts: [ { mime: "application/vnd.vega-lite.v5+json", spec: { mark: "bar", data: { values: [{ x: "a", y: 3 }, { x: "b", y: 5 }] }, encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } } } }, { mime: "text/plain", text: "Small bar chart" } ] } }
  ] } });
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
  it("preserves a compaction summary before a kept suffix that starts mid tool turn", () => {
    const messages = toSessionMessages([
      {
        role: "compactionSummary",
        timestamp: 1_779_132_415_000,
        summary: "## Goal\nThe initial prompt was autotime series. Earlier turns reviewed Sequence V6.",
        tokensBefore: 278_185,
      },
      {
        role: "assistant",
        timestamp: 1_779_132_416_000,
        content: [
          { type: "toolCall", id: "call_kept", name: "bash", arguments: { command: "union status" } },
        ],
      },
      {
        role: "toolResult",
        timestamp: 1_779_132_417_000,
        toolCallId: "call_kept",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "token prefix eyJ..." }],
      },
      {
        role: "user",
        timestamp: 1_779_142_915_000,
        content: [{ type: "text", text: "Can you tell me about Sequence V6?" }],
      },
    ]);

    expect(messages[0]).toMatchObject({
      role: "summary",
      content: expect.stringContaining("autotime series"),
      summaryKind: "compaction",
    });
    expect(messages[1]).toMatchObject({
      role: "tool",
      tool: expect.objectContaining({ name: "bash", output: "token prefix eyJ..." }),
    });
    expect(messages[2]).toMatchObject({ role: "user", content: "Can you tell me about Sequence V6?" });

    expect(toDashboardMessages(messages)[0]).toMatchObject({
      role: "summary",
      text: expect.stringContaining("autotime series"),
      summaryKind: "compaction",
    });
  });

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

    const messages = await session.handle.getMessages();
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "custom",
        customType: "artifact",
        content: "Small bar chart (Vega-Lite spec, 170 B)",
        details: expect.objectContaining({
          artifactGroupId: "abc123",
          caption: "Small bar chart",
          artifacts: expect.arrayContaining([
            expect.objectContaining({ mime: "application/vnd.vega-lite.v5+json" }),
            expect.objectContaining({ mime: "text/plain", text: "Small bar chart" }),
          ]),
        }),
      }),
      expect.objectContaining({ role: "assistant", content: "hello from rpc" }),
      expect.objectContaining({
        role: "tool",
        content: "> pi-crust@0.0.0 test\nPASS tests/unit/foo.test.ts",
        tool: expect.objectContaining({
          id: "call_hist",
          name: "bash",
          args: { command: "npm test" },
          status: "success",
          output: "> pi-crust@0.0.0 test\nPASS tests/unit/foo.test.ts",
        }),
      }),
    ]));

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

  it("maps get_session_stats token and cost data into session state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-remote-pirpc-stats-test-"));
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    await fs.mkdir(projectRoot, { recursive: true });
    const piCommand = await makeFakePiRpcExecutable(root);
    const registry = new SessionRegistry({
      adapter: new PiRpcAdapter({ piCommand, sessionDir: sessionRoot, artifactExtension: false }),
      pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
    });

    const session = await registry.createSession({ cwd: projectRoot });
    const state = await session.handle.getState();

    expect(state.totalTokens).toBe(44_689);
    expect(state.stats).toEqual({
      inputTokens: 12_345,
      outputTokens: 6_789,
      cacheReadTokens: 22_222,
      cacheWriteTokens: 3_333,
      cost: 0.9876,
      contextTokens: 42_424,
      contextPercent: 42,
      contextWindow: 1_000_000,
    });

    await registry.disposeAll();
  });

  it("propagates piRemoteControlArtifact from a toolResult details into tool.artifact", () => {
    const artifact = {
      version: 1,
      kind: "presentation",
      title: "Demo deck",
      data: { title: "Demo deck", slides: [{ title: "Title" }] },
    };
    const messages = toSessionMessages([
      {
        role: "assistant",
        timestamp: 1_000,
        content: [
          { type: "toolCall", id: "call_pres", name: "show_presentation", arguments: { title: "Demo deck", slides: [{ title: "Title" }] } },
        ],
      },
      {
        role: "toolResult",
        timestamp: 2_000,
        toolCallId: "call_pres",
        toolName: "show_presentation",
        isError: false,
        content: [{ type: "text", text: "Displayed presentation deck: Demo deck (1 slide)." }],
        details: { piRemoteControlArtifact: artifact },
      },
    ]);
    expect(messages.length).toBe(1);
    expect(messages[0]).toMatchObject({
      role: "tool",
      tool: expect.objectContaining({
        name: "show_presentation",
        status: "success",
        output: expect.stringContaining("Demo deck"),
        artifact,
      }),
    });
    expect(toDashboardMessages(messages)[0]?.tool).toMatchObject({ artifact });
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
