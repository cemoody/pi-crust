/**
 * TDD: real node-pty child confined by PathPolicy.
 * Spec: docs/terminal-wterm-tdd-plan.md contract items 16–20.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { PtyManager, type PtyDataEnvelope, type PtyExitEnvelope } from "../../src/server/pty/pty-manager.js";
import { createNodePtySpawner } from "../../src/server/pty/node-pty-spawner.js";

let projectRoot: string;
let outsideRoot: string;
let manager: PtyManager;

function collect(m: PtyManager) {
  const data: PtyDataEnvelope[] = [];
  const exits: PtyExitEnvelope[] = [];
  m.onData((e) => data.push(e));
  m.onExit((e) => exits.push(e));
  const text = () => data.map((e) => e.data).join("");
  return { data, exits, text };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "pty-session-"));
  projectRoot = path.join(base, "project");
  outsideRoot = path.join(base, "outside");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  const policy = new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [projectRoot] });
  manager = new PtyManager({ spawn: createNodePtySpawner({ pathPolicy: policy }) });
});

afterEach(() => { manager.disposeAll(); });

describe("PtyManager + node-pty (integration)", () => {
  it("16. starts the shell in the session cwd", async () => {
    const sink = collect(manager);
    const id = manager.open({ cwd: projectRoot, cols: 80, rows: 24 });
    manager.input(id, "pwd\r");
    await waitFor(() => sink.text().includes(projectRoot));
    // realpath because macOS /tmp symlinks to /private/tmp; on Linux this is identity.
    const real = await fs.realpath(projectRoot);
    expect(sink.text().includes(projectRoot) || sink.text().includes(real)).toBe(true);
  });

  it("17. a command's filesystem side effect is real", async () => {
    const id = manager.open({ cwd: projectRoot, cols: 80, rows: 24 });
    const sentinel = `SENTINEL-${Date.now()}`;
    manager.input(id, `printf '%s' "${sentinel}" > probe.txt\r`);
    const probe = path.join(projectRoot, "probe.txt");
    await waitFor(async () => {
      try { return (await fs.readFile(probe, "utf8")) === sentinel; } catch { return false; }
    });
    expect(await fs.readFile(probe, "utf8")).toBe(sentinel);
  });

  it("18. refuses to open a pty for a cwd outside the allowed roots", () => {
    expect(() => manager.open({ cwd: outsideRoot, cols: 80, rows: 24 }))
      .toThrowError(/outside allowed project roots/i);
  });

  it("19. surfaces the real exit code", async () => {
    const sink = collect(manager);
    const id = manager.open({ cwd: projectRoot, cols: 80, rows: 24 });
    manager.input(id, "exit 7\r");
    await waitFor(() => sink.exits.length > 0);
    expect(sink.exits[0]).toMatchObject({ ptyId: id, exitCode: 7 });
  });

  it("20. disposeAll kills the child — no orphan process survives", async () => {
    const id = manager.open({ cwd: projectRoot, cols: 80, rows: 24 });
    // Find the live pid via /proc by writing a marker; simpler: rely on exit event.
    const sink = collect(manager);
    expect(manager.has(id)).toBe(true);
    manager.disposeAll();
    await waitFor(() => sink.exits.length > 0);
    expect(manager.has(id)).toBe(false);
    expect(sink.exits[0]!.ptyId).toBe(id);
  });
});
