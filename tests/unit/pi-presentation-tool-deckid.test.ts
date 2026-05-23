import { describe, expect, it } from "vitest";
import piRemoteArtifacts from "../../src/server/pi/extensions/pi-crust-artifacts.js";

type RegisteredTool = {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
};

function loadTool(name: string): RegisteredTool {
  const tools: RegisteredTool[] = [];
  piRemoteArtifacts({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

describe("show_presentation — deck identity", () => {
  it("assigns a stable id (slug of the title) when caller omits one", async () => {
    const tool = loadTool("show_presentation");
    const result = await tool.execute("call-1", {
      title: "Executive Signal Brief",
      slides: [{ title: "T", subtitle: "S" }],
    }) as { details: { piRemoteControlArtifact: { data: { id: string; title: string } } } };
    const deck = result.details.piRemoteControlArtifact.data;
    expect(deck.id).toBe("executive-signal-brief");
  });

  it("is deterministic: same title → same id across calls", async () => {
    const tool = loadTool("show_presentation");
    const a = (await tool.execute("call-a", {
      title: "Quarterly Review",
      slides: [{ title: "T" }],
    })) as { details: { piRemoteControlArtifact: { data: { id: string } } } };
    const b = (await tool.execute("call-b", {
      title: "Quarterly Review",
      slides: [{ title: "T" }],
    })) as { details: { piRemoteControlArtifact: { data: { id: string } } } };
    const idA = a.details.piRemoteControlArtifact.data.id;
    const idB = b.details.piRemoteControlArtifact.data.id;
    expect(idA).toBeTruthy();
    expect(idA).toBe(idB);
  });

  it("preserves an explicit id when the caller provides one", async () => {
    const tool = loadTool("show_presentation");
    const result = (await tool.execute("call-1", {
      id: "custom-deck-id",
      title: "Anything",
      slides: [{ title: "T" }],
    })) as { details: { piRemoteControlArtifact: { data: { id: string } } } };
    expect(result.details.piRemoteControlArtifact.data.id).toBe("custom-deck-id");
  });

  it("propagates id into the data payload AND into the artifact envelope", async () => {
    const tool = loadTool("show_presentation");
    const result = (await tool.execute("call-1", {
      title: "Hello World",
      slides: [{ title: "T" }],
    })) as {
      details: {
        piRemoteControlArtifact: {
          deckId?: string;
          data: { id: string };
        };
      };
    };
    const envelope = result.details.piRemoteControlArtifact;
    expect(envelope.data.id).toBe("hello-world");
    expect(envelope.deckId).toBe("hello-world");
  });
});
