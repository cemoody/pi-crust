/**
 * Meta-smoke for the LiveStack orchestrator itself: prove that one
 * startLiveStack() call brings up the REAL server (via dev-api.mjs + fake-pi),
 * answers /api/health, and tears down cleanly with no leaked port.
 *
 * This is not a robustness scenario — it's the "is the harness wired
 * correctly?" canary that every other scenario depends on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startLiveStack, type LiveStack } from "../helpers/live-stack.js";
import { tcpListenersOnPort } from "../helpers/process-tree.js";

const stacks: LiveStack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) { try { await s.teardown(); } catch { /* ignore */ } }
});

describe("meta: LiveStack orchestrator", () => {
  it("boots the real server, serves /api/health, and tears down cleanly", async () => {
    const stack = await startLiveStack({ label: "smoke" });
    stacks.push(stack);

    const h = await stack.api.health();
    expect(h.ok).toBe(true);
    // The server runs from the sandbox checkout cwd.
    expect(String(h["defaultCwd"] ?? "")).toContain(stack.checkout);

    // The port is owned by a descendant of our loop.
    await stack.assert.portOwnedByUs();

    // Teardown frees the port.
    const port = stack.port;
    await stack.teardown();
    stacks.splice(stacks.indexOf(stack), 1);
    expect((await tcpListenersOnPort(port)).length).toBe(0);
  });
});
