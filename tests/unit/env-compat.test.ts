import { describe, expect, it } from "vitest";
import { installEnvCompat } from "../../src/shared/env-compat.js";

describe("installEnvCompat", () => {
  it("mirrors PI_REMOTE_* to PI_CRUST_* when the new key is unset", () => {
    const env: NodeJS.ProcessEnv = { PI_REMOTE_API_PORT: "9999", PI_CRUST_SUPPRESS_RENAME_WARNING: "1" };
    const { mirrored } = installEnvCompat(env);
    expect(env.PI_CRUST_API_PORT).toBe("9999");
    expect(mirrored).toContain("PI_REMOTE_API_PORT");
  });

  it("does NOT overwrite PI_CRUST_* if it's already set", () => {
    const env: NodeJS.ProcessEnv = {
      PI_REMOTE_API_PORT: "9999",
      PI_CRUST_API_PORT: "8888",
      PI_CRUST_SUPPRESS_RENAME_WARNING: "1",
    };
    installEnvCompat(env);
    expect(env.PI_CRUST_API_PORT).toBe("8888");
  });

  it("is idempotent on repeat calls within the same process", () => {
    const env: NodeJS.ProcessEnv = { PI_REMOTE_FOO: "1", PI_CRUST_SUPPRESS_RENAME_WARNING: "1" };
    installEnvCompat(env);
    const second = installEnvCompat(env);
    expect(second.mirrored).toEqual([]);
  });

  it("ignores non-PI_REMOTE env vars", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/x", PI_CRUST_SUPPRESS_RENAME_WARNING: "1" };
    const { mirrored } = installEnvCompat(env);
    expect(mirrored).toEqual([]);
  });
});
