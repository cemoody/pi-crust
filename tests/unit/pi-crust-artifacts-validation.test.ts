import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piRemoteArtifacts from "../../src/server/pi/extensions/pi-crust-artifacts.js";

/**
 * These tests cover the bash-style "the tool call should fail if its inputs
 * are wrong" validation we added to `show_artifact`. The motivating bug:
 * passing a `path` that the pi-crust can't actually fetch over HTTP silently
 * produced a broken-image artifact instead of an obvious tool failure.
 *
 * The behavior we want:
 *   - kind=image with a missing path  -> throws (tool call fails)
 *   - kind=image with a path outside the allow-list -> throws
 *   - kind=image with a valid path -> details.path is absolute and
 *     details.url is /api/artifact-file?path=<abs>
 *   - kind=markdown IS now file-backable: a `path` (with no inline `markdown`)
 *     is validated against the same allow-list AND the file contents are
 *     INLINED into details.markdown, because the web markdown renderer needs
 *     the inline string (it never fetches a markdown URL). Missing/outside
 *     allow-list paths throw, mirroring image. Inline `markdown` still wins.
 *   - other non-file-backed artifacts (vega-lite, json, ...) are unaffected
 */

type RegisteredTool = {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{
    content: Array<{ text: string }>;
    details: { piRemoteControlArtifact?: Record<string, unknown> };
  }>;
};

function makeShowArtifact(): RegisteredTool {
  const tools: RegisteredTool[] = [];
  piRemoteArtifacts({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  const tool = tools.find((candidate) => candidate.name === "show_artifact");
  if (!tool) throw new Error("show_artifact tool was not registered");
  return tool;
}

describe("show_artifact path validation", () => {
  let workdir: string;
  let originalCwd: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "prc-show-artifact-"));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("throws when kind=image is given a path that doesn't exist", async () => {
    const tool = makeShowArtifact();
    const missing = path.join(workdir, "does-not-exist.png");

    await expect(tool.execute("call-1", { kind: "image", path: missing })).rejects.toThrow(/file not found/);
  });

  it("throws when kind=image is given an empty path string", async () => {
    const tool = makeShowArtifact();
    // We mimic the case where the agent passes an empty string but the
    // tool params still see it as defined. The validator treats this as
    // a hard failure rather than silently ignoring the param.
    await expect(tool.execute("call-1", { kind: "image", path: "  " })).rejects.toThrow(/path/);
  });

  it("throws when kind=image is given a path with a NUL byte", async () => {
    const tool = makeShowArtifact();
    await expect(tool.execute("call-1", { kind: "image", path: "/tmp/evil\u0000.png" })).rejects.toThrow(/NUL/);
  });

  it("throws when kind=image is given a path outside the allow-list", async () => {
    const tool = makeShowArtifact();
    // /etc/hostname exists on essentially every Linux box but is well
    // outside our allow-list (tmpdir, homedir, cwd). We don't read its
    // contents; we just confirm the validator rejects it before touching
    // the file.
    await expect(tool.execute("call-1", { kind: "image", path: "/etc/hostname" })).rejects.toThrow(/allow-list/);
  });

  it("accepts an absolute path inside the OS tmpdir and emits a fetchable url", async () => {
    const tool = makeShowArtifact();
    const filePath = path.join(workdir, "bottom.png");
    // 1x1 PNG header + trailer is fine for the file-exists check.
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const result = await tool.execute("call-1", { kind: "image", path: filePath, title: "Bottom" });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.kind).toBe("image");
    expect(artifact.path).toBe(filePath);
    expect(typeof artifact.url).toBe("string");
    expect(artifact.url as string).toMatch(/^\/api\/artifact-file\?path=/);
    expect(artifact.url as string).toContain(encodeURIComponent(filePath));
    expect(artifact.mimeType).toBe("image/png");
  });

  it("resolves a relative path against process.cwd() when validating", async () => {
    const tool = makeShowArtifact();
    process.chdir(workdir);
    await fs.writeFile(path.join(workdir, "plot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await tool.execute("call-1", { kind: "image", path: "plot.png" });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.path).toBe(path.join(workdir, "plot.png"));
    expect(artifact.url as string).toContain(encodeURIComponent(path.join(workdir, "plot.png")));
  });

  it("respects a caller-supplied mimeType override even when the file is valid", async () => {
    const tool = makeShowArtifact();
    const filePath = path.join(workdir, "weird.bin");
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await tool.execute("call-1", { kind: "image", path: filePath, mimeType: "image/x-png-clone" });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.mimeType).toBe("image/x-png-clone");
  });

  it("does not validate path for non-file-backed kinds (e.g. vega-lite)", async () => {
    const tool = makeShowArtifact();
    // A vega-lite artifact has its content in `data`, not a file. Passing
    // a `path` here is unusual but should be a no-op rather than failing,
    // because the pi-crust ignores path for kind=vega-lite.
    const result = await tool.execute("call-1", {
      kind: "vega-lite",
      title: "Chart",
      data: { mark: "bar" },
      // intentionally bogus path: should not trip validation for this kind
      path: "/does/not/exist.json",
    });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.kind).toBe("vega-lite");
    expect(artifact.path).toBe("/does/not/exist.json");
    expect(artifact.url).toBeUndefined();
  });

  it("emits a fetchable url (not inline html) for kind=html with a valid path", async () => {
    // Contract the path-backed HTML renderer fix depends on: a kind=html
    // artifact with a `path` resolves to an absolute path + artifact-file
    // url + text/html mimeType, and does NOT inline the file body into
    // `html` (unlike markdown — html is rendered via <iframe src=url>).
    const tool = makeShowArtifact();
    const filePath = path.join(workdir, "email.html");
    await fs.writeFile(filePath, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");

    const result = await tool.execute("call-1", { kind: "html", path: filePath, title: "Email" });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.kind).toBe("html");
    expect(artifact.path).toBe(filePath);
    expect(typeof artifact.url).toBe("string");
    expect(artifact.url as string).toMatch(/^\/api\/artifact-file\?path=/);
    expect(artifact.url as string).toContain(encodeURIComponent(filePath));
    expect(artifact.mimeType as string).toMatch(/^text\/html\b/);
    // The renderer reads the file via the url; the body is not inlined.
    expect(artifact.html).toBeUndefined();
  });

  it("throws when kind=html is given a path that doesn't exist (parity with image)", async () => {
    const tool = makeShowArtifact();
    const missing = path.join(workdir, "nope.html");
    await expect(tool.execute("call-1", { kind: "html", path: missing })).rejects.toThrow(/file not found/);
  });

  it("inlines the file contents into details.markdown for kind=markdown with a valid path", async () => {
    const tool = makeShowArtifact();
    const filePath = path.join(workdir, "report.md");
    const body = "# My Report\n\nThis is the body of the report.\n\n- one\n- two\n";
    await fs.writeFile(filePath, body, "utf8");

    const result = await tool.execute("call-1", { kind: "markdown", path: filePath, title: "My Report" });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.kind).toBe("markdown");
    // The fix: the file's contents must be inlined into `markdown` so the
    // web renderer renders it instead of falling back to the JSON card.
    expect(artifact.markdown).toBe(body);
    // Path/url are also resolved (parity with image/html file-backing).
    expect(artifact.path).toBe(filePath);
    expect(artifact.url as string).toMatch(/^\/api\/artifact-file\?path=/);
  });

  it("resolves a relative markdown path against process.cwd() and inlines it", async () => {
    const tool = makeShowArtifact();
    process.chdir(workdir);
    const body = "## Relative\n\nresolved against cwd\n";
    await fs.writeFile(path.join(workdir, "rel.md"), body, "utf8");

    const result = await tool.execute("call-1", { kind: "markdown", path: "rel.md" });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.markdown).toBe(body);
    expect(artifact.path).toBe(path.join(workdir, "rel.md"));
  });

  it("throws when kind=markdown is given a path that doesn't exist (parity with image)", async () => {
    const tool = makeShowArtifact();
    const missing = path.join(workdir, "nope.md");
    await expect(tool.execute("call-1", { kind: "markdown", path: missing })).rejects.toThrow(/file not found/);
  });

  it("throws when kind=markdown is given a path outside the allow-list", async () => {
    const tool = makeShowArtifact();
    await expect(tool.execute("call-1", { kind: "markdown", path: "/etc/hostname" })).rejects.toThrow(/allow-list/);
  });

  it("keeps inline markdown (no path read) when both markdown and path are provided", async () => {
    const tool = makeShowArtifact();
    // Inline markdown wins; the path is NOT read (here it doesn't even exist,
    // which would throw if we attempted to file-back it).
    const missing = path.join(workdir, "ignored.md");
    const result = await tool.execute("call-1", {
      kind: "markdown",
      markdown: "inline body",
      path: missing,
    });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.markdown).toBe("inline body");
  });

  it("emits inline markdown unchanged when only `markdown` is provided (regression)", async () => {
    const tool = makeShowArtifact();
    const result = await tool.execute("call-1", { kind: "markdown", markdown: "# Hi", title: "T" });
    const artifact = result.details.piRemoteControlArtifact!;
    expect(artifact.kind).toBe("markdown");
    expect(artifact.markdown).toBe("# Hi");
    expect(artifact.path).toBeUndefined();
    expect(artifact.url).toBeUndefined();
  });

  it("blocks symlinks that escape the allow-list", async () => {
    const tool = makeShowArtifact();
    // Drop a symlink inside tmpdir pointing at /etc/hostname. realpath()
    // resolves it to the target, and the target lives outside the allow-list,
    // so the validator must reject.
    const linkPath = path.join(workdir, "sneaky.png");
    try {
      await fs.symlink("/etc/hostname", linkPath);
    } catch (error) {
      // Some filesystems (e.g. CI sandboxes) disallow symlink creation.
      // Skip the assertion in that case; the realpath-based check is
      // already covered by the "outside allow-list" test above.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(tool.execute("call-1", { kind: "image", path: linkPath })).rejects.toThrow(/allow-list/);
  });
});
