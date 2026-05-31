/**
 * Scenario (Feature A — health-gated auto rollout):
 *
 *   The git-puller currently does `git pull --ff-only` straight into the live
 *   working tree, and the dev-api loop restarts on the file change. There is no
 *   smoke gate: a commit that breaks boot (e.g. the 2026-05-29 duplicate
 *   show_pr_story extension that crashed every worker) lands directly and takes
 *   the live server down. Rollback is manual.
 *
 *   The robust contract we want (Feature A):
 *     1. A *green* push to origin/main is rolled out automatically and the live
 *        /api/health gitSha advances to the new commit, with sessions intact.
 *     2. A *breaking* push is staged + smoke-tested and REFUSED: the live
 *        gitSha stays on the last-known-good commit and a clear "rollout
 *        blocked / smoke failed" line is logged. The server stays up.
 *
 * Expected status:
 *   - sub-case 1 (green) may already pass via the naive pull+restart path.
 *   - sub-case 2 (broken) is RED until the smoke-gate / promote pipeline lands.
 *
 * NOTE: these drive the real puller against the fake remote. The "breaking"
 * commit is represented by a sentinel file (BREAK_DUP_EXTENSION); the smoke
 * gate (to be built) is what must learn to reject it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startLiveStack, type LiveStack } from "../helpers/live-stack.js";

const stacks: LiveStack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) { try { await s.teardown(); } catch { /* ignore */ } }
});

describe("scenario: health-gated auto rollout", () => {
  it("1) rolls out a green push and advances the live gitSha", async () => {
    const stack = await startLiveStack({ label: "rollout-green", realCheckout: true, withPuller: true, autoRollout: true });
    stacks.push(stack);

    const before = (await stack.api.health()).gitSha;
    expect(before, "health should expose a gitSha").toBeTruthy();

    const newSha = await stack.remote.pushCommit({ "VERSION": "v1\n" }, "green bump");
    expect(newSha).not.toBe(before);

    await stack.waitForRollout(before!, 30_000);

    const after = (await stack.api.health()).gitSha;
    expect(after, "live gitSha should advance after a green rollout").not.toBe(before);
    await stack.assert.sessionsHealthy();
  });

  it("2) refuses a breaking push and stays on last-known-good", async () => {
    const stack = await startLiveStack({ label: "rollout-broken", realCheckout: true, withPuller: true, autoRollout: true });
    stacks.push(stack);

    const good = (await stack.api.health()).gitSha;
    expect(good).toBeTruthy();

    await stack.remote.pushBreaking("dup-extension");

    // Give the puller several poll intervals to (attempt to) roll out.
    await new Promise((r) => setTimeout(r, 6000));

    // Contract: the live gitSha must NOT have moved to the broken commit, and
    // the server must still be healthy.
    const now = (await stack.api.health()).gitSha;
    expect(now, "must stay on last-known-good after a broken push").toBe(good);
    expect((await stack.api.health()).ok).toBe(true);

    // Contract: a clear blocked-rollout diagnostic somewhere in puller/loop logs.
    const logs = stack.pullerLog() + stack.log();
    expect(logs, `logs:\n${logs}`).toMatch(/smoke failed|rollout blocked|did not promote|kept last-known-good/i);
  });
});
