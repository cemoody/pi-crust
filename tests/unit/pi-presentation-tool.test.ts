import { describe, expect, it } from "vitest";
import piRemoteArtifacts from "../../src/server/pi/extensions/pi-crust-artifacts.js";

type RegisteredTool = {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
};

describe("Pi presentation tool extension", () => {
  it("registers show_presentation with artifact details consumed by pi-crust", async () => {
    const tools: RegisteredTool[] = [];
    piRemoteArtifacts({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);

    const tool = tools.find((candidate) => candidate.name === "show_presentation");
    expect(tool).toBeTruthy();
    expect(tool?.promptSnippet).toMatch(/slide decks/i);
    expect(tool?.promptGuidelines?.join("\n")).toMatch(/structured deck/i);

    const result = await tool!.execute("call-1", {
      title: "Executive Signal Brief",
      theme: "light",
      slides: [{ title: "Title", subtitle: "Subtitle" }, { title: "Signals", bullets: ["Permits"] }],
    }) as { content: Array<{ text: string }>; details: Record<string, unknown> };

    expect(result.content[0]?.text).toContain("Executive Signal Brief");
    expect(result.details.piRemoteControlArtifact).toMatchObject({
      version: 1,
      kind: "presentation",
      title: "Executive Signal Brief",
      data: {
        title: "Executive Signal Brief",
        theme: "light",
        slides: [{ title: "Title", subtitle: "Subtitle" }, { title: "Signals", bullets: ["Permits"] }],
      },
    });
  });

  it("rejects malformed decks with a structured error so the LLM can self-correct", async () => {
    const tools: RegisteredTool[] = [];
    piRemoteArtifacts({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
    const tool = tools.find((candidate) => candidate.name === "show_presentation")!;

    // image passed as a string instead of { src, alt? } — the exact mistake
    // observed in the bug report. The tool must throw (not silently succeed)
    // and the message must name the bad field + suggest the right shape.
    await expect(tool.execute("call-bad-image", {
      title: "Bad image",
      slides: [
        { title: "Cover" },
        { title: "Pic", image: "https://example.com/cat.png" },
      ],
    })).rejects.toThrow(/slides\[1\]\.image must be an object/);

    // Missing image.src.
    await expect(tool.execute("call-no-src", {
      title: "No src",
      slides: [{ title: "x", image: { alt: "oops" } }],
    })).rejects.toThrow(/slides\[0\]\.image\.src is required/);

    // The error message should include the shape hint so the model knows what
    // to send next time.
    try {
      await tool.execute("call-shape", {
        title: "Shape",
        slides: [{ title: "x", image: "u" }],
      });
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Expected slide shape");
      expect(msg).toContain("image?: { src: string");
      expect(msg).toContain("call show_presentation again");
    }
  });

  it("keeps show_artifact backwards-compatible for presentation artifacts", async () => {
    const tools: RegisteredTool[] = [];
    piRemoteArtifacts({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
    const tool = tools.find((candidate) => candidate.name === "show_artifact")!;

    const deck = { title: "Deck", slides: [{ title: "One" }] };
    const result = await tool.execute("call-1", { kind: "presentation", title: "Deck", data: deck }) as { details: Record<string, unknown> };

    expect(result.details.piRemoteControlArtifact).toMatchObject({ kind: "presentation", title: "Deck", data: deck });
  });

  it("registers list_presentation_templates that calls the /api/presentations/templates route", async () => {
    const tools: RegisteredTool[] = [];
    piRemoteArtifacts({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
    const tool = tools.find((candidate) => candidate.name === "list_presentation_templates");
    expect(tool).toBeDefined();

    const fetched: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ packs: [
        { id: "brainco", name: "BrainCo", version: "0.1.0", dir: "/tmp/brainco", layouts: ["title-light", "contents"] },
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      process.env.PI_CRUST_API_BASE = "http://127.0.0.1:9999";
      const result = await tool!.execute("toolCallId", {}) as { content: { text: string }[]; details: { packs: { id: string }[] } };
      expect(fetched).toContain("http://127.0.0.1:9999/api/presentations/templates");
      expect(result.details.packs[0]?.id).toBe("brainco");
      expect(result.content[0]?.text).toMatch(/brainco: 2 layout/);
    } finally {
      globalThis.fetch = original;
      delete process.env.PI_CRUST_API_BASE;
    }
  });
});
