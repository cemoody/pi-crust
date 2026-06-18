import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import piRemoteArtifacts from "../../src/server/pi/extensions/pi-crust-artifacts.js";

type RegisteredTool = {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  parameters?: unknown;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
};

function loadTool(name: string): RegisteredTool {
  const tools: RegisteredTool[] = [];
  piRemoteArtifacts({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

describe("Pi presentation tool extension", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pres-tool-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeSpec(spec: unknown): Promise<string> {
    const specPath = path.join(tmpRoot, `deck-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(specPath, JSON.stringify(spec), "utf8");
    return specPath;
  }

  it("reads the deck spec from a JSON file path and emits artifact details consumed by pi-crust", async () => {
    const tool = loadTool("show_presentation");
    expect(tool.promptSnippet).toMatch(/slide decks/i);
    expect(tool.promptGuidelines?.join("\n")).toMatch(/JSON file/i);

    const specPath = await writeSpec({
      title: "Executive Signal Brief",
      theme: "light",
      slides: [{ title: "Title", subtitle: "Subtitle" }, { title: "Signals", bullets: ["Permits"] }],
    });

    const result = await tool.execute("call-1", { path: specPath }) as {
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    };

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

  it("no longer accepts an inline slides array — the schema only exposes `path`", async () => {
    const tool = loadTool("show_presentation");
    // The parameter schema must not declare a `slides` (or `title`) property
    // any more; the entire deck lives in the JSON file referenced by `path`.
    const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema?.properties).toBeTruthy();
    expect(Object.keys(schema.properties ?? {})).toContain("path");
    expect(Object.keys(schema.properties ?? {})).not.toContain("slides");
    expect(schema.required).toContain("path");
  });

  it("rejects an inline deck passed via params (no `path`)", async () => {
    const tool = loadTool("show_presentation");
    await expect(tool.execute("call-inline", {
      title: "Inline",
      slides: [{ title: "Title" }],
    })).rejects.toThrow(/path/i);
  });

  it("throws a readable error when the spec file does not exist", async () => {
    const tool = loadTool("show_presentation");
    await expect(tool.execute("call-missing", {
      path: path.join(tmpRoot, "nope.json"),
    })).rejects.toThrow(/could not read|no such file|ENOENT/i);
  });

  it("throws a readable error when the spec file is not valid JSON", async () => {
    const tool = loadTool("show_presentation");
    const badPath = path.join(tmpRoot, "bad.json");
    await fs.writeFile(badPath, "{not json", "utf8");
    await expect(tool.execute("call-bad-json", { path: badPath })).rejects.toThrow(/parse|JSON/i);
  });

  it("rejects malformed decks (read from file) with a structured error so the LLM can self-correct", async () => {
    const tool = loadTool("show_presentation");

    // image passed as a string instead of { src, alt? }.
    await expect(tool.execute("call-bad-image", {
      path: await writeSpec({
        title: "Bad image",
        slides: [{ title: "Cover" }, { title: "Pic", image: "https://example.com/cat.png" }],
      }),
    })).rejects.toThrow(/slides\[1\]\.image must be an object/);

    // Missing image.src.
    await expect(tool.execute("call-no-src", {
      path: await writeSpec({ title: "No src", slides: [{ title: "x", image: { alt: "oops" } }] }),
    })).rejects.toThrow(/slides\[0\]\.image\.src is required/);

    // Absolute filesystem path.
    await expect(tool.execute("call-abs-path", {
      path: await writeSpec({
        title: "Coastal",
        slides: [{ title: "Cover" }, { title: "Landfalls", image: { src: "/home/coder/adhoc/bz_coastal/slide_02_landfalls.png" } }],
      }),
    })).rejects.toThrow(/slides\[1\]\.image\.src is unsafe.*absolute path.*\.pi\/presentations/s);

    // Parent-directory traversal is also unsafe.
    await expect(tool.execute("call-dotdot", {
      path: await writeSpec({ title: "Traversal", slides: [{ title: "x", image: { src: "../../../etc/passwd" } }] }),
    })).rejects.toThrow(/slides\[0\]\.image\.src is unsafe.*path traversal/);

    // https:// and data: URIs and bare relative filenames must still pass.
    await expect(tool.execute("call-ok", {
      path: await writeSpec({
        title: "OK",
        slides: [
          { title: "a", image: { src: "https://example.com/x.png" } },
          { title: "b", image: { src: "data:image/png;base64,AAA" } },
          { title: "c", image: { src: "chart.png" } },
          { title: "d", image: { src: "sub/chart.png" } },
        ],
      }),
    })).resolves.toBeTruthy();

    // The error message should include the shape hint.
    try {
      await tool.execute("call-shape", {
        path: await writeSpec({ title: "Shape", slides: [{ title: "x", image: "u" }] }),
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
    const tool = loadTool("show_artifact");
    const deck = { title: "Deck", slides: [{ title: "One" }] };
    const result = await tool.execute("call-1", { kind: "presentation", title: "Deck", data: deck }) as { details: Record<string, unknown> };
    expect(result.details.piRemoteControlArtifact).toMatchObject({ kind: "presentation", title: "Deck", data: deck });
  });

  it("registers list_presentation_templates that calls the /api/presentations/templates route", async () => {
    const tool = loadTool("list_presentation_templates");
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
      const result = await tool.execute("toolCallId", {}) as { content: { text: string }[]; details: { packs: { id: string }[] } };
      expect(fetched).toContain("http://127.0.0.1:9999/api/presentations/templates");
      expect(result.details.packs[0]?.id).toBe("brainco");
      expect(result.content[0]?.text).toMatch(/brainco: 2 layout/);
    } finally {
      globalThis.fetch = original;
      delete process.env.PI_CRUST_API_BASE;
    }
  });
});
