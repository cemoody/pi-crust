/**
 * Static check: every script under scripts/ must open with a
 * /**...*\/ or `# ...` comment block of at least N lines that
 * explains:
 *   1. what it does, and
 *   2. what failure mode it guards against.
 *
 * The discipline is what makes the codebase debuggable in an outage —
 * `scripts/dev-api.mjs` and `scripts/dev-loop.sh` both already pay this
 * cost and proved invaluable on 2026-05-23. This test enforces it.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPTS_DIR = path.resolve(__dirname, "..", "..", "scripts");
const MIN_HEADER_LINES = 6;

async function loadScripts(): Promise<Array<{ file: string; text: string }>> {
  const entries = await fs.readdir(SCRIPTS_DIR);
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of entries) {
    if (!/\.(mjs|cjs|js|ts|sh)$/.test(entry)) continue;
    const full = path.join(SCRIPTS_DIR, entry);
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    out.push({ file: entry, text: await fs.readFile(full, "utf8") });
  }
  return out;
}

function leadingCommentLines(text: string): number {
  const lines = text.split("\n");
  let i = 0;
  // Skip shebang + blank lines.
  if (lines[i]?.startsWith("#!")) i++;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  let count = 0;
  const head = (lines[i] ?? "").trim();
  if (head.startsWith("/**") || head.startsWith("/*")) {
    while (i < lines.length && !(lines[i] ?? "").includes("*/")) { i++; count++; }
    if (i < lines.length) count++;
  } else if (head.startsWith("//")) {
    while (i < lines.length && (lines[i] ?? "").trim().startsWith("//")) { i++; count++; }
  } else {
    while (i < lines.length && (lines[i] ?? "").startsWith("#") && !(lines[i] ?? "").startsWith("#!")) {
      i++; count++;
    }
  }
  return count;
}

describe("static: script header discipline", () => {
  it("every script under scripts/ has a documenting header of at least 6 lines", async () => {
    const violations: string[] = [];
    for (const src of await loadScripts()) {
      const count = leadingCommentLines(src.text);
      if (count < MIN_HEADER_LINES) {
        violations.push(`${src.file}: header is only ${count} lines (need ≥ ${MIN_HEADER_LINES})`);
      }
    }
    expect(violations).toEqual([]);
  });
});
