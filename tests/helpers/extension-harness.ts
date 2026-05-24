import { createPrcExtensionHost, type ActivateExtensionInput, type PrcExtensionHost } from "../../src/extensions/registry.js";
import { createTempPrcHome, type TempPrcHome } from "./temp-pi-crust-home.js";

export interface PrcExtensionHarness {
  readonly home: TempPrcHome;
  readonly extensions: PrcExtensionHost;
  cleanup(): Promise<void>;
}

export interface CreatePrcExtensionHarnessOptions {
  readonly extensions?: readonly ActivateExtensionInput[];
}

export async function createPrcExtensionHarness(options: CreatePrcExtensionHarnessOptions = {}): Promise<PrcExtensionHarness> {
  const home = await createTempPrcHome();
  const extensions = createPrcExtensionHost();
  await extensions.activateAll(options.extensions ?? []);
  return {
    home,
    extensions,
    cleanup: async () => {
      await extensions.dispose();
      await home.cleanup();
    },
  };
}
