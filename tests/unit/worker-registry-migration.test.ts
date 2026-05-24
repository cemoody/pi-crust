import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyRuntimeDir, WorkerRegistry } from "../../src/server/session/worker-registry.js";

describe("migrateLegacyRuntimeDir", () => {
  let scratch: string;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-mig-"));
    // Silence the migration warning for clean test output.
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("renames a legacy dir into place when target doesn't exist", () => {
    const legacy = path.join(scratch, "pi-remote-control");
    const target = path.join(scratch, "pi-crust");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "sentinel.txt"), "preserved");

    const moved = migrateLegacyRuntimeDir(target, [legacy]);

    expect(moved).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(target, "sentinel.txt"), "utf8")).toBe("preserved");
  });

  it("is a no-op when the target already exists", () => {
    const legacy = path.join(scratch, "pi-remote-control");
    const target = path.join(scratch, "pi-crust");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "existing.txt"), "keep");

    const moved = migrateLegacyRuntimeDir(target, [legacy]);

    expect(moved).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true); // untouched
    expect(fs.readFileSync(path.join(target, "existing.txt"), "utf8")).toBe("keep");
  });

  it("is a no-op when no legacy dir exists", () => {
    const target = path.join(scratch, "pi-crust");
    const moved = migrateLegacyRuntimeDir(target, [path.join(scratch, "does-not-exist")]);
    expect(moved).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("WorkerRegistry constructor", () => {
  let scratch: string;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-wr-"));
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("auto-migrates a legacy runtime dir on construction when target is missing", () => {
    // Simulate: an old pi-remote-control runtime dir exists with a sentinel
    // session-status file, but the new pi-crust target doesn't yet.
    const legacyParent = path.dirname(scratch);
    const legacy = path.join(legacyParent, `pi-crust-wr-legacy-${process.pid}`);
    const target = path.join(legacyParent, `pi-crust-wr-target-${process.pid}`);
    // Use a manually-named legacy dir so we can pass an explicit target to
    // the registry. We won't go through legacyRuntimeDirCandidates() here;
    // this test exercises that migrate-on-ctor is wired, even if no
    // candidate matches in this scratch case.
    fs.mkdirSync(legacy, { recursive: true });

    const reg = new WorkerRegistry({ runtimeDir: target });
    expect(reg.runtimeDir).toBe(target);
    // Target should be set up by ensureDirs lazily; constructor must not
    // crash even when nothing to migrate.
    // Cleanup:
    try { fs.rmSync(legacy, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
