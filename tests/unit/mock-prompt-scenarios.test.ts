import { describe, expect, it } from "vitest";
import { runMockPromptScenario, type MockPromptScenarioContext } from "../../src/server/pi/mock-prompt-scenarios.js";
import type { PiEvent, SessionMessage, SessionStatus } from "../../src/server/pi/types.js";

function scenarioContext(): { context: MockPromptScenarioContext; events: PiEvent[]; messages: SessionMessage[]; statuses: SessionStatus[]; persisted: { count: number } } {
  const events: PiEvent[] = [];
  const messages: SessionMessage[] = [];
  const statuses: SessionStatus[] = [];
  const persisted = { count: 0 };
  return {
    context: {
      id: "session-1",
      cwd: "/tmp/mock-session",
      appendMessage: (message) => messages.push(message),
      emit: (event) => events.push(event),
      persist: async () => { persisted.count += 1; },
      setStatus: (status) => statuses.push(status),
      setLastActivity: () => {},
    },
    events,
    messages,
    statuses,
    persisted,
  };
}

describe("mock prompt scenarios", () => {
  it("does not claim ordinary prompts so the adapter can handle them", async () => {
    const { context, events, messages } = scenarioContext();

    await expect(runMockPromptScenario("ordinary prompt", context)).resolves.toBe(false);
    expect(events).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("emits and persists the login artifact as a live custom-message turn", async () => {
    const { context, events, messages, statuses, persisted } = scenarioContext();

    await expect(runMockPromptScenario("@@login", context)).resolves.toBe(true);

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "custom"]);
    expect(messages[2]).toMatchObject({
      customType: "artifact",
      details: {
        artifacts: [
          { mime: "text/html", height: 520 },
          { mime: "text/plain", text: "Live GitHub login — sign in to continue" },
        ],
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "message",
      "message",
      "message_start",
      "message_end",
      "agent_end",
    ]);
    expect(persisted.count).toBe(1);
    expect(statuses).toEqual(["running", "idle"]);
  });
});
