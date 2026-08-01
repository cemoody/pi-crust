import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcAdapter } from "../../src/server/pi/pirpc-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";
import { WorkerRegistry } from "../../src/server/session/worker-registry.js";
import { makeFakePi, type FakePi } from "../helpers/fake-pi.js";
import { waitForNoLiveWorkers } from "./pirpc-supervision-cleanup.js";

const roots: string[] = [];
const fakePis: FakePi[] = [];
const registries: SessionRegistry[] = [];
const workerRegistries: WorkerRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll().catch(() => undefined)));
  // dispose() asks the detached supervisor to exit, but its status-file
  // cleanup races the test sandbox removal unless we wait for the supervisor
  // to acknowledge shutdown. This is lifecycle synchronization, not a retry
  // of the behavior under test.
  await Promise.all(workerRegistries.splice(0).map(waitForNoLiveWorkers));
  await Promise.all(fakePis.splice(0).map((fake) => fake.cleanup()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Pi RPC supervision boundary", () => {
  it("keeps a detached worker discoverable through WorkerRegistry and reconnects it through a fresh adapter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-supervision-boundary-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    const runtimeDir = path.join(root, "runtime");
    await fs.mkdir(projectRoot, { recursive: true });

    const fakePi = await makeFakePi({ sessionId: "supervision-contract" });
    fakePis.push(fakePi);
    const workers = new WorkerRegistry({ runtimeDir });
    workerRegistries.push(workers);
    const policy = new PathPolicy({
      allowedProjectRoots: [projectRoot],
      allowedSessionRoots: [sessionRoot],
    });
    const firstRegistry = new SessionRegistry({
      adapter: new PiRpcAdapter({
        piCommand: fakePi.executable,
        sessionDir: sessionRoot,
        runtimeDir,
        artifactExtension: false,
      }),
      pathPolicy: policy,
      workerRegistry: workers,
    });
    registries.push(firstRegistry);

    const created = await firstRegistry.createSession({ cwd: projectRoot });
    const statusPath = workers.statusPath(created.id);
    const persisted = JSON.parse(await fs.readFile(statusPath, "utf8")) as {
      sessionId: string;
      socketPath: string;
      cwd: string;
      sessionFile: string;
    };
    expect(persisted).toEqual(expect.objectContaining({
      sessionId: created.id,
      cwd: projectRoot,
      sessionFile: created.sessionFile,
    }));
    expect(persisted.socketPath).toBe(workers.socketPath(created.id));

    await firstRegistry.detachAll();
    expect(firstRegistry.hotSessionCount).toBe(0);
    await expect(fs.access(statusPath)).resolves.toBeUndefined();

    const secondRegistry = new SessionRegistry({
      adapter: new PiRpcAdapter({
        piCommand: fakePi.executable,
        sessionDir: sessionRoot,
        runtimeDir,
        artifactExtension: false,
      }),
      pathPolicy: policy,
      workerRegistry: workers,
    });
    registries.push(secondRegistry);

    expect(await secondRegistry.reattachAll()).toEqual([created.id]);
    const reattached = secondRegistry.getSession(created.id);
    await expect(reattached.handle.getState()).resolves.toMatchObject({
      id: created.id,
      cwd: projectRoot,
      sessionFile: created.sessionFile,
      modelProvider: "fake",
      model: "model",
    });
    expect(reattached.handle.isHealthy?.()).toBe(true);
  });
});
