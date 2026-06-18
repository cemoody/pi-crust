/**
 * TDD: show_presentation reads the deck spec from a JSON file path and should
 * auto-copy absolute local paths that live under the session cwd into
 * <cwd>/.pi/presentations/<sessionId>/ and rewrite each image.src / logo.src
 * to the bare filename the asset route serves. Anything outside cwd, or
 * non-existent, still hits the actionable validator error from #166 so the
 * LLM can self-correct.
 *
 * The tool exposes a single hook for tests: an extension factory option
 * that injects `getSessionContext(): { sessionId, cwd }`. Production
 * code wires this from the `session_start` event; tests inject directly.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import piRemoteArtifacts from "../../src/server/pi/extensions/pi-crust-artifacts.js";

type RegisteredTool = {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
};

describe("show_presentation auto-copy of local assets", () => {
  let tmpRoot: string;
  let cwd: string;
  let originalCwd: string;
  let tool: RegisteredTool;
  let specSeq = 0;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-autocopy-"));
    cwd = path.join(tmpRoot, "session-cwd");
    await fs.mkdir(cwd, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(cwd);

    const tools: RegisteredTool[] = [];
    // The extension factory takes an internal options bag for tests that
    // pins the (sessionId, cwd) the tool would otherwise resolve from
    // session_start.
    piRemoteArtifacts({
      registerTool: (t: RegisteredTool) => tools.push(t),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, {
      getSessionContext: () => ({ sessionId: "sess-1", cwd }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    tool = tools.find((t) => t.name === "show_presentation")!;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Spec files are written OUTSIDE cwd so they don't pollute the
  // .pi/presentations target dir assertions.
  async function specFile(spec: unknown): Promise<string> {
    const p = path.join(tmpRoot, `spec-${specSeq++}.json`);
    await fs.writeFile(p, JSON.stringify(spec), "utf8");
    return p;
  }

  it("succeeds when image.src is an absolute path under cwd, after copying + rewriting", async () => {
    const assetAbs = path.join(cwd, "adhoc", "landfalls.png");
    await fs.mkdir(path.dirname(assetAbs), { recursive: true });
    await fs.writeFile(assetAbs, "IMG");

    const result = (await tool.execute("call-1", {
      path: await specFile({
        title: "buildzoom hurricane data",
        slides: [{ title: "Title" }, { title: "Landfalls", image: { src: assetAbs } }],
      }),
    })) as { content: Array<{ text: string }>; details: Record<string, unknown> };

    expect(result.content[0]?.text).toContain("buildzoom hurricane data");

    // The asset got copied into <cwd>/.pi/presentations/sess-1/...
    const targetDir = path.join(cwd, ".pi", "presentations", "sess-1");
    const files = await fs.readdir(targetDir);
    expect(files).toContain("landfalls.png");

    // And the persisted deck's src is the bare filename.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persistedDeck = (result.details as any).piRemoteControlArtifact.data;
    expect(persistedDeck.slides[1].image.src).toBe("landfalls.png");
  });

  it("still throws an actionable error when the path is OUTSIDE cwd", async () => {
    const outsideAbs = path.join(tmpRoot, "outside.png"); // tmpRoot is a parent of cwd
    await fs.writeFile(outsideAbs, "EVIL");

    await expect(tool.execute("call-2", {
      path: await specFile({
        title: "Outside",
        slides: [{ title: "x" }, { title: "y", image: { src: outsideAbs } }],
      }),
    })).rejects.toThrow(/slides\[1\]\.image\.src is unsafe/);
  });

  it("still throws when the absolute path under cwd does NOT exist", async () => {
    const ghost = path.join(cwd, "missing.png");
    await expect(tool.execute("call-3", {
      path: await specFile({ title: "Ghost", slides: [{ title: "x", image: { src: ghost } }] }),
    })).rejects.toThrow(/slides\[0\]\.image\.src is unsafe|image\.src.*does not exist/);
  });

  it("leaves https:// and bare relative srcs alone (no copy, no error)", async () => {
    const result = (await tool.execute("call-4", {
      path: await specFile({
        title: "Mix",
        slides: [
          { title: "a", image: { src: "https://example.com/x.png" } },
          { title: "b", image: { src: "chart.png" } },
        ],
      }),
    })) as { details: Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deck = (result.details as any).piRemoteControlArtifact.data;
    expect(deck.slides[0].image.src).toBe("https://example.com/x.png");
    expect(deck.slides[1].image.src).toBe("chart.png");
    // Target dir should not have been created since nothing was copied.
    await expect(
      fs.stat(path.join(cwd, ".pi", "presentations", "sess-1")),
    ).rejects.toThrow();
  });

  it("auto-copies logo.src too", async () => {
    const logoAbs = path.join(cwd, "brand", "logo.png");
    await fs.mkdir(path.dirname(logoAbs), { recursive: true });
    await fs.writeFile(logoAbs, "LOGO");
    const result = (await tool.execute("call-5", {
      path: await specFile({
        title: "Brand",
        logo: { src: logoAbs },
        slides: [{ title: "x" }],
      }),
    })) as { details: Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _deck = (result.details as any).piRemoteControlArtifact.data;
    expect(_deck.title).toBe("Brand");
    expect(_deck.logo.src).toBe("logo.png");
  });
});
