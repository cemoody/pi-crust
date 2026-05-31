/**
 * Scenario (Feature C — single-owner + loud failures):
 *
 *   Reproduces the 2026-05-2x "port war" crash-loop. A foreign process holds
 *   the API port. The dev-api loop's child can't bind (EADDRINUSE), exits, and
 *   the loop respawns it on a fixed delay — forever — only throttling the log
 *   line. From the operator's seat this looks like a silent, churning box: the
 *   API never comes up and the cause (someone ELSE owns the port) is buried.
 *
 *   The robust contract we want (Feature C):
 *     - The loop detects that the port is held by a process that is NOT one of
 *       its own descendants and emits a single, unmistakable diagnostic
 *       ("port 8787 owned by pid=… cwd=… — not ours; refusing to crash-loop")
 *       and backs off (or exits non-zero) instead of tight-respawning.
 *     - It does NOT kill the foreign holder (single-owner means we yield, not
 *       fight — fighting is how two supervisors ping-ponged the port).
 *
 * Expected status: RED until Feature C lands. This is the executable spec.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { startLiveStack, type LiveStack } from "../helpers/live-stack.js";
import { waitFor } from "../helpers/process-tree.js";

const stacks: LiveStack[] = [];
const squatters: ChildProcess[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) { try { await s.teardown(); } catch { /* ignore */ } }
  for (const sq of squatters.splice(0)) { try { sq.kill("SIGKILL"); } catch { /* ignore */ } }
});

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") { srv.close(); reject(new Error("no port")); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function spawnSquatter(port: number): Promise<ChildProcess> {
  const script =
    `import http from "node:http";` +
    `const s=http.createServer((_,r)=>{r.writeHead(200);r.end("squatter")});` +
    `s.listen(${port},"127.0.0.1",()=>process.stdout.write("ready\\n"));`;
  const sq = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  squatters.push(sq);
  return new Promise((resolve, reject) => {
    sq.stdout?.on("data", (c) => { if (c.toString().includes("ready")) resolve(sq); });
    sq.once("exit", () => reject(new Error("squatter exited before ready")));
    setTimeout(() => reject(new Error("squatter not ready in 3s")), 3000);
  });
}

describe("scenario: foreign port squatter is refused, not fought", () => {
  it("emits a single-owner diagnostic and does not tight-respawn", async () => {
    const port = await pickFreePort();
    await spawnSquatter(port);

    // Start the loop pointed at the already-held port; it must NOT come up as ours.
    const stack = await startLiveStack({ label: "squat", port, expectRefusal: true });
    stacks.push(stack);

    // Give the loop a few seconds to react.
    await waitFor(() => /not ours|refusing|owned by pid=/.test(stack.log()), {
      timeoutMs: 12_000,
      pollMs: 250,
      label: "single-owner diagnostic in loop log",
    }).catch(() => { /* assertion below gives the real message */ });

    const log = stack.log();
    // Contract: a clear single-owner message naming the foreign holder.
    expect(log, `loop log:\n${log}`).toMatch(/not ours|refusing to crash-loop|single-owner/i);

    // Contract: no tight crash-loop. Count spawn attempts; a healthy refusal
    // backs off, so we should see at most a couple of spawn lines, not dozens.
    const spawnAttempts = (log.match(/spawned pid=/g) ?? []).length;
    expect(spawnAttempts, `saw ${spawnAttempts} spawn attempts (tight-loop?)`).toBeLessThanOrEqual(3);
  });
});
