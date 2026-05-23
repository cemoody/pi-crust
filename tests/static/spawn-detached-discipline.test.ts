/**
 * Static check: any long-running child process spawned by code under
 * scripts/ must use `detached: true` AND its kill site must signal the
 * entire process group via `process.kill(-pgid, ...)`. The whole point
 * of dev-api.mjs's "proper process-group cleanup" guarantee is that
 * npm/sh don't forward signals to their grandchildren — only a group
 * signal reliably reaps the tree.
 *
 * This test greps scripts/ for `spawn(` and asserts:
 *   - if the call assigns to a variable that's later passed to a kill
 *     function, the spawn options include `detached: true`.
 *
 * It's intentionally coarse — it errs on the side of false positives
 * and asks for an explicit `// no-pgid:` comment to suppress when a
 * spawn is genuinely short-lived (e.g. spawnSync, or a one-shot
 * spawnSync wrapped in spawn for streaming).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPTS_DIR = path.resolve(__dirname, "..", "..", "scripts");

interface ScriptSource {
  file: string;
  text: string;
}

async function loadScripts(): Promise<ScriptSource[]> {
  const entries = await fs.readdir(SCRIPTS_DIR);
  const out: ScriptSource[] = [];
  for (const entry of entries) {
    if (!/\.(mjs|cjs|js|ts)$/.test(entry)) continue;
    const full = path.join(SCRIPTS_DIR, entry);
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    out.push({ file: entry, text: await fs.readFile(full, "utf8") });
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
}

describe("static: spawn() discipline in scripts/", () => {
  it("every long-running spawn() carries detached: true (or an opt-out comment)", async () => {
    const violations: string[] = [];
    for (const src of await loadScripts()) {
      const lines = src.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (isCommentLine(line)) continue;
        // `spawn(` (but not `spawnSync(`) on a non-comment line. We assume
        // the call closes within ~12 lines (covers single + multi-line forms).
        // Match real spawn(...) calls. The trailing character class
        // excludes literals like `spawn()` and `spawn() failure` inside
        // strings/log messages, which don't actually invoke spawn.
        if (!/(?:^|[^A-Za-z_])spawn\(["'A-Za-z_$]/.test(line)) continue;
        if (/spawnSync\(/.test(line)) continue;
        const block = lines.slice(Math.max(0, i - 3), Math.min(i + 14, lines.length)).join("\n");
        // Opt-out: explicit comment saying we don't need a pgid.
        if (/no-pgid:/.test(block)) continue;
        // If the call doesn't mention `detached`, that's a violation.
        if (!/detached:\s*true/.test(block)) {
          violations.push(`${src.file}:${i + 1}  ${line.trim()}`);
        }
      }
    }
    expect(violations, `scripts/ spawn() calls missing detached:true. Add 'no-pgid:' comment to opt out:\n  ${violations.join("\n  ")}`).toEqual([]);
  });

  it("every kill of a spawned long-running child uses pgid signaling", async () => {
    const violations: string[] = [];
    for (const src of await loadScripts()) {
      const lines = src.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (isCommentLine(line)) continue;
        // Heuristic: `.kill(` on a child handle without an opt-out comment.
        // The discipline is: prefer process.kill(-pid, ...). If a script does
        // `child.kill(...)` it must justify it adjacent or earlier.
        if (!/\bchild\.kill\(/.test(line)) continue;
        const window = lines.slice(Math.max(0, i - 6), Math.min(i + 6, lines.length)).join("\n");
        if (/pgid-via-supervisor:|killGroup\(/.test(window)) continue;
        violations.push(`${src.file}:${i + 1}  ${line.trim()}`);
      }
    }
    expect(violations, `child.kill() without pgid-via-supervisor opt-out:\n  ${violations.join("\n  ")}`).toEqual([]);
  });
});
