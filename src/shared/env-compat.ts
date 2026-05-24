/**
 * Backward-compatibility shim for the PI_REMOTE_* → PI_CRUST_* env-var rename.
 *
 * For every PI_REMOTE_FOO env var set, mirror its value into PI_CRUST_FOO
 * when PI_CRUST_FOO is unset, and emit a one-time deprecation warning per
 * env object that lists the old names. Existing PI_REMOTE_*-based configs
 * keep working unmodified during the deprecation window; new code reads
 * PI_CRUST_* exclusively.
 *
 * Side-effect auto-install lives in {@link ./env-compat-auto} so this
 * module can be imported in tests without firing against process.env.
 *
 * Removal plan: after one published release with the warning, remove the
 * mirror and require callers to use PI_CRUST_* directly.
 */

// Prefix pairs to mirror (old -> new). VITE_* is also covered since Vite
// requires that exact prefix to expose env vars to the client bundle.
const PREFIX_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["PI_REMOTE_", "PI_CRUST_"],
  ["VITE_PI_REMOTE_", "VITE_PI_CRUST_"],
];

// Track which env objects have already been processed so callers can call
// installEnvCompat() defensively without triggering double-warnings.
const processed = new WeakSet<NodeJS.ProcessEnv>();

export function installEnvCompat(env: NodeJS.ProcessEnv = process.env): {
  mirrored: string[];
} {
  if (processed.has(env)) return { mirrored: [] };
  processed.add(env);

  const mirrored: string[] = [];
  for (const key of Object.keys(env)) {
    for (const [oldPrefix, newPrefix] of PREFIX_PAIRS) {
      if (!key.startsWith(oldPrefix)) continue;
      const newKey = newPrefix + key.slice(oldPrefix.length);
      if (env[newKey] !== undefined) break; // explicit new takes precedence
      env[newKey] = env[key];
      mirrored.push(key);
      break;
    }
  }

  if (mirrored.length > 0 && env.PI_CRUST_SUPPRESS_RENAME_WARNING !== "1") {
    const pretty = mirrored
      .map((k) => {
        for (const [oldPrefix, newPrefix] of PREFIX_PAIRS) {
          if (k.startsWith(oldPrefix)) return `${k} -> ${newPrefix}${k.slice(oldPrefix.length)}`;
        }
        return k;
      })
      .join(", ");
    process.stderr.write(
      `[pi-crust] deprecated env vars detected; mirroring to new names: ${pretty}\n` +
        `[pi-crust] update your config to PI_CRUST_*. Set PI_CRUST_SUPPRESS_RENAME_WARNING=1 to silence.\n`,
    );
  }

  return { mirrored };
}

// Test-only: clear the processed-env tracking so a test can drive
// installEnvCompat against a fresh env object multiple times in one run.
export function _resetEnvCompatForTests(): void {
  // WeakSet has no clear(); replace the binding. Closing over `processed`
  // means tests have to import the named binding via a fresh module load
  // if they want a clean slate — using vitest's vi.resetModules(). For
  // direct testing with new env objects, no reset is needed.
}
