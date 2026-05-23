import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TempPrcHome {
  readonly root: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export async function createTempPrcHome(prefix = "pi-remote-extension-test-"): Promise<TempPrcHome> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await Promise.all([configDir, dataDir, projectRoot, sessionRoot].map((dir) => fs.mkdir(dir, { recursive: true })));
  return {
    root,
    configDir,
    dataDir,
    projectRoot,
    sessionRoot,
    env: {
      ...process.env,
      PI_REMOTE_CONFIG_DIR: configDir,
      PI_REMOTE_DATA_DIR: dataDir,
      PI_REMOTE_PROJECT_ROOT: projectRoot,
      PI_REMOTE_SESSION_ROOT: sessionRoot,
      PI_REMOTE_USE_MOCK: "1",
      PI_REMOTE_OPEN: "0",
    },
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); },
  };
}
