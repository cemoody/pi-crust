import { describe, expect, it } from "vitest";
import { APP_NAME, PROTOCOL_VERSION, getVersionSummary } from "../../src/shared/version.js";

describe("project skeleton", () => {
  it("exposes a stable app name", () => {
    expect(APP_NAME).toBe("pi-crust");
  });

  it("starts protocol versioning at 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(getVersionSummary()).toBe("pi-crust:protocol-1");
  });
});
