import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pres-deckid-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function specFile(spec: unknown): Promise<string> {
    const p = path.join(tmpRoot, `deck-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(p, JSON.stringify(spec), "utf8");
    return p;
  }

  it("assigns a stable id (slug of the title) when the spec omits one", async () => {
    const tool = loadTool("show_presentation");
    const result = await tool.execute("call-1", {
      path: await specFile({ title: "Executive Signal Brief", slides: [{ title: "T", subtitle: "S" }] }),
    }) as { details: { piRemoteControlArtifact: { data: { id: string; title: string } } } };
    const deck = result.details.piRemoteControlArtifact.data;
    expect(deck.id).toBe("executive-signal-brief");
  });

  it("is deterministic: same title → same id across calls", async () => {
    const tool = loadTool("show_presentation");
    const a = (await tool.execute("call-a", {
      path: await specFile({ title: "Quarterly Review", slides: [{ title: "T" }] }),
    })) as { details: { piRemoteControlArtifact: { data: { id: string } } } };
    const b = (await tool.execute("call-b", {
      path: await specFile({ title: "Quarterly Review", slides: [{ title: "T" }] }),
    })) as { details: { piRemoteControlArtifact: { data: { id: string } } } };
    const idA = a.details.piRemoteControlArtifact.data.id;
    const idB = b.details.piRemoteControlArtifact.data.id;
    expect(idA).toBeTruthy();
    expect(idA).toBe(idB);
  });

  it("preserves an explicit id when the spec provides one", async () => {
    const tool = loadTool("show_presentation");
    const result = (await tool.execute("call-1", {
      path: await specFile({ id: "custom-deck-id", title: "Anything", slides: [{ title: "T" }] }),
    })) as { details: { piRemoteControlArtifact: { data: { id: string } } } };
    expect(result.details.piRemoteControlArtifact.data.id).toBe("custom-deck-id");
  });

  it("propagates id into the data payload AND into the artifact envelope", async () => {
    const tool = loadTool("show_presentation");
    const result = (await tool.execute("call-1", {
      path: await specFile({ title: "Hello World", slides: [{ title: "T" }] }),
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
