import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piRemoteArtifacts from "../../src/server/pi/extensions/pi-crust-artifacts.js";

type RegisteredTool = {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  parameters?: unknown;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
};

function loadTool(name: string): RegisteredTool {
  const tools: RegisteredTool[] = [];
  piRemoteArtifacts({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

type FetchCall = { readonly url: string; readonly body?: unknown };

function installFetchMock(options: {
  readonly created?: { readonly id: string; readonly sessionFile?: string };
  readonly promptResponse?: unknown;
  readonly delayPromptUntil?: Promise<void>;
}) {
  const calls: FetchCall[] = [];
  const created = options.created ?? { id: "child-1", sessionFile: "/tmp/child-1.jsonl" };
  const promptResponse = options.promptResponse ?? [
    { role: "user", text: "do the task" },
    { role: "assistant", text: "done from child" },
  ];

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/api/sessions")) {
      return jsonResponse(created);
    }
    if (String(url).endsWith(`/api/sessions/${encodeURIComponent(created.id)}/prompt`)) {
      if (options.delayPromptUntil) await options.delayPromptUntil;
      return jsonResponse(promptResponse);
    }
    return jsonResponse({ error: `unexpected url ${String(url)}` }, 500);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("spawn_prc_session tool", () => {
  const originalApiBase = process.env.PI_CRUST_API_BASE;
  const originalUiBase = process.env.PI_CRUST_UI_BASE;

  beforeEach(() => {
    process.env.PI_CRUST_API_BASE = "http://api.test";
    process.env.PI_CRUST_UI_BASE = "http://ui.test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiBase === undefined) delete process.env.PI_CRUST_API_BASE;
    else process.env.PI_CRUST_API_BASE = originalApiBase;
    if (originalUiBase === undefined) delete process.env.PI_CRUST_UI_BASE;
    else process.env.PI_CRUST_UI_BASE = originalUiBase;
  });

  /**
   * TDD expectation / acceptance criteria:
   * - The tool schema exposes an optional boolean `subagent` flag.
   * - Omitting it preserves existing wholesale-session behavior.
   * - Setting it to true means the spawned session is treated as a child
   *   agent: the parent tool call waits for the child prompt to complete and
   *   returns the child session's prompt result in `details`.
   */
  it("declares an optional boolean subagent parameter and documents when to use it", () => {
    const tool = loadTool("spawn_prc_session");
    const schema = tool.parameters as { properties?: Record<string, { type?: string }>; required?: string[] };

    expect(schema.properties?.subagent?.type).toBe("boolean");
    expect(schema.required ?? []).not.toContain("subagent");
    expect(tool.description).toMatch(/subagent/i);
    expect(tool.promptGuidelines?.join("\n")).toMatch(/subagent/i);
  });

  it("keeps default wholesale spawning fire-and-forget and marks prompt delivery as background", async () => {
    const gate = deferred();
    const { calls } = installFetchMock({ delayPromptUntil: gate.promise });
    const tool = loadTool("spawn_prc_session");

    const result = await tool.execute("call-1", {
      prompt: "do the task",
      cwd: "/repo",
      sessionName: "Wholesale Child",
    });

    expect(result.content[0]?.text).toMatch(/Prompt delivery is running in the background/);
    expect(calls).toEqual([
      { url: "http://api.test/api/sessions", body: { cwd: "/repo", sessionName: "Wholesale Child" } },
      { url: "http://api.test/api/sessions/child-1/prompt", body: { text: "do the task" } },
    ]);
    const details = result.details.spawnedPiRemoteControlSession as Record<string, unknown>;
    expect(details.subagent).toBe(false);
    expect(details.promptDelivery).toBe("background");
    expect(details.subagentResult).toBeUndefined();

    gate.resolve();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });

  it("when subagent=true waits for the child prompt and returns the child session result", async () => {
    const { calls } = installFetchMock({
      promptResponse: [
        { role: "user", text: "inspect auth" },
        { role: "assistant", text: "Auth review complete: no blockers." },
      ],
    });
    const tool = loadTool("spawn_prc_session");

    const result = await tool.execute("call-2", {
      prompt: "inspect auth",
      cwd: "/repo",
      sessionName: "Auth subagent",
      subagent: true,
    });

    expect(calls).toEqual([
      { url: "http://api.test/api/sessions", body: { cwd: "/repo", sessionName: "Auth subagent", subagent: true, hiddenFromList: true } },
      { url: "http://api.test/api/sessions/child-1/prompt", body: { text: "inspect auth" } },
    ]);
    expect(result.content[0]?.text).toMatch(/Subagent session child-1 .*completed/);
    expect(result.content[0]?.text).toContain("Auth review complete: no blockers.");
    const details = result.details.spawnedPiRemoteControlSession as Record<string, unknown>;
    expect(details).toMatchObject({
      version: 1,
      sessionId: "child-1",
      sessionFile: "/tmp/child-1.jsonl",
      cwd: "/repo",
      sessionName: "Auth subagent",
      url: "http://ui.test/?session=child-1",
      subagent: true,
      promptDelivery: "completed",
    });
    expect(details.subagentResult).toEqual({
      messages: [
        { role: "user", text: "inspect auth" },
        { role: "assistant", text: "Auth review complete: no blockers." },
      ],
      messageCount: 2,
      lastAssistantMessage: "Auth review complete: no blockers.",
    });
  });
});
