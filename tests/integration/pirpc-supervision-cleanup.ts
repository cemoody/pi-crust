import { WorkerRegistry } from "../../src/server/session/worker-registry.js";

/**
 * Wait until detached supervisors have removed their worker status records
 * before a test deletes the runtime directory that contains them.
 */
export async function waitForNoLiveWorkers(workers: WorkerRegistry): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await workers.listAlive()).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Pi RPC supervisor did not exit during test cleanup");
}
