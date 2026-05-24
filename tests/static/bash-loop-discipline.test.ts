/**
 * Static check: any infinite-loop bash script under scripts/ or
 * adjacent shell scripts (~/bin/prc-loop.sh equivalents shipped in the
 * repo) must have a `trap` for at least SIGTERM and SIGINT, AND must
 * `wait` on its children. Otherwise it leaks: see prc-loop.sh's bash
 * git puller, which had neither and died silently for 80 minutes on
 * 2026-05-15.
 *
 * This is *static* — it doesn't run the scripts. It just enforces the
 * shape so we catch new offenders at PR time.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPTS_DIR = path.resolve(__dirname, "..", "..", "scripts");

interface ShellScript {
  file: string;
  text: string;
}

async function loadShellScripts(): Promise<ShellScript[]> {
  const entries = await fs.readdir(SCRIPTS_DIR);
  const out: ShellScript[] = [];
  for (const entry of entries) {
    if (!/\.sh$/.test(entry)) continue;
    const full = path.join(SCRIPTS_DIR, entry);
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    out.push({ file: entry, text: await fs.readFile(full, "utf8") });
  }
  return out;
}

describe("static: bash loop discipline in scripts/*.sh", () => {
  it("every script with `while :` or `while true` has a trap for TERM and INT", async () => {
    const violations: string[] = [];
    for (const src of await loadShellScripts()) {
      const hasInfiniteLoop = /while\s+(:|true)\s*;\s*do/.test(src.text);
      if (!hasInfiniteLoop) continue;
      const trapMatch = src.text.match(/\btrap\s+[^\n]+/g) ?? [];
      const trapText = trapMatch.join(" ");
      const hasTerm = /TERM/.test(trapText) || /EXIT/.test(trapText);
      const hasInt = /INT/.test(trapText) || /EXIT/.test(trapText);
      if (!(hasTerm && hasInt)) {
        violations.push(`${src.file}: while-true loop without trap on TERM+INT (or EXIT)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every backgrounded process (`cmd &`) has a `wait` somewhere", async () => {
    const violations: string[] = [];
    for (const src of await loadShellScripts()) {
      // Strip comments first so `& \`-in-comments don't count.
      const stripped = src.text.split("\n").map((l) => l.replace(/#.*$/, "")).join("\n");
      const hasBackground = /(^|[^&])&\s*(\n|$)/.test(stripped) && /\$!/.test(stripped);
      if (!hasBackground) continue;
      const hasWait = /\bwait\b/.test(stripped);
      if (!hasWait) violations.push(`${src.file}: backgrounded process without 'wait'`);
    }
    expect(violations).toEqual([]);
  });
});
