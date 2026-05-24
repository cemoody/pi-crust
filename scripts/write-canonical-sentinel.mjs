#!/usr/bin/env node
/**
 * Drop a `.pi-canonical` sentinel inside `node_modules/` so that
 * `scripts/safe-symlink-node-modules.sh` (and any other tool that
 * cares) can distinguish a real install from an inherited symlink.
 *
 * Wired into the `prepare` lifecycle in package.json so every
 * `npm install` (whether by a human, an agent, or npx) refreshes the
 * sentinel. We tolerate the "node_modules doesn't exist" case (some
 * very early install steps run prepare before node_modules is in
 * place; npm itself creates it after).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const nm = path.join(repoRoot, "node_modules");
const sentinel = path.join(nm, ".pi-canonical");

try {
  // Don't write into a symlink — that's the very case we're trying to
  // diagnose against, and writing through the link would corrupt the
  // canonical install elsewhere.
  const stat = fs.lstatSync(nm);
  if (stat.isSymbolicLink()) {
    process.stderr.write(`write-canonical-sentinel: ${nm} is a symlink; skipping (this is not the canonical worktree)\n`);
    process.exit(0);
  }
  fs.writeFileSync(
    sentinel,
    [
      "This file marks a CANONICAL pi-crust install (a real node_modules directory, not a symlink).",
      "",
      "scripts/safe-symlink-node-modules.sh refuses to overwrite a directory that contains this",
      "sentinel, so an agent/script that mistakenly runs the 'share node_modules from canonical'",
      "recipe FROM the canonical worktree can't clobber it into a self-referential symlink.",
      "",
      "Created by scripts/write-canonical-sentinel.mjs, invoked from the `prepare` lifecycle.",
      `Last written: ${new Date().toISOString()}`,
      "",
    ].join("\n"),
  );
} catch (err) {
  if (err && err.code === "ENOENT") {
    // node_modules doesn't exist yet — fine, the next npm install will
    // re-run prepare and we'll write it then.
    process.exit(0);
  }
  process.stderr.write(`write-canonical-sentinel: ${err && err.message ? err.message : err}\n`);
  // Don't fail prepare for this; it's a defensive aid, not a hard requirement.
  process.exit(0);
}
