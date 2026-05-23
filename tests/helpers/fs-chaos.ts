/**
 * fs-chaos: helpers to deterministically reproduce the pathological
 * filesystem states that have taken down the dev box in the past. Every
 * function here is a fixture: it builds a sandbox directory, plants the
 * exact broken shape we've seen in the wild, and returns paths the test
 * can drive through dev-api / pirpc-supervisor / dev-git-puller.
 *
 * Why this exists: the bugs are not in the code, they're in the
 * environment. Each function here is a one-line `await` that snapshots
 * a real incident.
 *
 * All sandboxes are created under os.tmpdir() and are caller-owned;
 * callers must call cleanup() in an afterEach.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface Sandbox {
  readonly root: string;
  cleanup(): Promise<void>;
}

async function mkSandbox(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function rmAll(root: string): Promise<void> {
  return fs.rm(root, { recursive: true, force: true });
}

export type CyclicVariant = "self" | "nested-bin" | "nested-tsx";

/**
 * Build a node_modules-shaped tree where some symlink loops back on itself.
 *
 *   variant=self        node_modules -> ../<root>/node_modules     (today's-canonical)
 *   variant=nested-bin  node_modules/.bin/tsx is a self-symlink    (today's-outage)
 *   variant=nested-tsx  node_modules/tsx -> ../node_modules/tsx    (today's-outage v2)
 *
 * In every variant a child spawn of `node_modules/.bin/tsx` ELOOPs synchronously.
 */
export async function makeCyclicNodeModules(opts: {
  prefix?: string;
  variant: CyclicVariant;
}): Promise<Sandbox & { tsxBin: string; cyclicPath: string }> {
  const root = await mkSandbox(opts.prefix ?? "fs-chaos-cyclic-nm-");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fs-chaos-sandbox",
    version: "0.0.0",
    private: true,
    type: "module",
  }, null, 2) + "\n");
  const nm = path.join(root, "node_modules");
  const tsxBin = path.join(nm, ".bin", "tsx");
  let cyclicPath = "";

  if (opts.variant === "self") {
    // The canonical "agent ran `ln -s ../pi-crust/node_modules .` from
    // inside the canonical worktree" bug.
    await fs.symlink(nm, nm);
    cyclicPath = nm;
  } else if (opts.variant === "nested-bin") {
    // node_modules is a real directory but node_modules/.bin/tsx loops.
    // This is today's outage shape: `npm run dev:api` -> tsx lookup ELOOPs.
    await fs.mkdir(path.join(nm, ".bin"), { recursive: true });
    await fs.symlink(tsxBin, tsxBin);
    cyclicPath = tsxBin;
  } else if (opts.variant === "nested-tsx") {
    // node_modules/tsx -> node_modules/tsx (so .bin/tsx -> ../tsx/dist/cli.mjs ELOOPs).
    await fs.mkdir(path.join(nm, ".bin"), { recursive: true });
    const tsxDir = path.join(nm, "tsx");
    await fs.symlink(tsxDir, tsxDir);
    await fs.symlink(path.join("..", "tsx", "dist", "cli.mjs"), tsxBin);
    cyclicPath = tsxDir;
  }

  return { root, cleanup: () => rmAll(root), tsxBin, cyclicPath };
}

/**
 * Sandbox git repo with a deterministic diverged-from-origin shape: two
 * branches that share a base commit then diverge with different commits.
 * Used to reproduce the "8-day silent fast-forward failure" puller bug.
 *
 * Returns a sandbox where:
 *   - origin/  is a bare repo
 *   - clone/   is a working clone of origin
 *   - origin's `main` has a commit that's NOT in clone's `main`
 *   - clone has been checked out on a branch other than main, OR has a
 *     conflicting commit on its main, depending on `mode`.
 */
export async function makeDivergedRepo(opts: {
  prefix?: string;
  mode: "wrong-branch" | "diverged-main" | "dirty-tree" | "clean-and-ff-able";
  branch?: string;
}): Promise<Sandbox & { repo: string; remote: string }> {
  const root = await mkSandbox(opts.prefix ?? "fs-chaos-git-");
  const remote = path.join(root, "origin.git");
  const repo = path.join(root, "clone");
  const branch = opts.branch ?? "main";
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      },
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r;
  };

  // Build an upstream repo with one initial commit on branch `main`.
  await fs.mkdir(remote, { recursive: true });
  git(remote, "init", "--bare", "--initial-branch", branch);

  const seed = path.join(root, "seed");
  await fs.mkdir(seed, { recursive: true });
  git(seed, "init", "--initial-branch", branch);
  git(seed, "remote", "add", "origin", remote);
  await fs.writeFile(path.join(seed, "README.md"), "seed\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "seed");
  git(seed, "push", "origin", branch);

  // Add a second commit on origin that the clone won't have yet.
  await fs.writeFile(path.join(seed, "remote-only.txt"), "remote\n");
  git(seed, "add", "remote-only.txt");
  git(seed, "commit", "-m", "remote only");
  git(seed, "push", "origin", branch);

  // Clone from origin (pre-second-commit) by resetting one commit back
  // and then cloning. Easier: clone fresh, then move HEAD/branch back.
  spawnSync("git", ["clone", remote, repo], { encoding: "utf8" });
  // Now repo's main is up-to-date. Walk it back so the puller has a real
  // diff to pull on the first iteration. We then mutate per `mode`.
  git(repo, "reset", "--hard", "HEAD~1");

  if (opts.mode === "wrong-branch") {
    git(repo, "checkout", "-b", "feature/test");
  } else if (opts.mode === "diverged-main") {
    // Local commit on main that conflicts with origin's "remote only" file.
    await fs.writeFile(path.join(repo, "remote-only.txt"), "LOCAL\n");
    git(repo, "add", "remote-only.txt");
    git(repo, "commit", "-m", "local diverging commit");
  } else if (opts.mode === "dirty-tree") {
    // Uncommitted changes on main.
    await fs.writeFile(path.join(repo, "dirty.txt"), "uncommitted\n");
    // Leave unstaged on purpose.
  }
  // mode=clean-and-ff-able: leave the clone at HEAD~1 of remote (a clean,
  // ff-able pull).

  return { root, repo, remote, cleanup: () => rmAll(root) };
}

/**
 * Build a sandbox project that "looks like" the pi-crust worktree but
 * uses only stdlib modules (no node_modules), so cyclic-symlink heals
 * don't need a real `npm install`. Useful for tests that want to exercise
 * dev-api.mjs without the 5-second install hit.
 */
export async function makeMinimalProject(opts: { prefix?: string } = {}): Promise<Sandbox> {
  const root = await mkSandbox(opts.prefix ?? "fs-chaos-min-");
  await fs.mkdir(path.join(root, "src", "server"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fs-chaos-min", version: "0.0.0", private: true, type: "module",
  }, null, 2) + "\n");
  return { root, cleanup: () => rmAll(root) };
}
