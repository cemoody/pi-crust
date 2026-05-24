/**
 * Cross-cutting tiny helpers that were copy-pasted across server, web, and
 * shared modules. Keep this file dependency-free so it can be imported from
 * any layer (Node server, browser, build scripts).
 */

/**
 * True when `value` is a plain object suitable for property access.
 * Excludes `null`, arrays, and primitives. Matches the historical
 * server/web behavior (the previous two copies in extensions/packages.ts
 * and presentations/schema.ts also excluded arrays in practice because
 * their callers only fed object-shaped JSON in).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Drop keys whose value is `undefined`. Useful with TS's
 * `exactOptionalPropertyTypes` to avoid the verbose
 * `...optional({ x })` spread pattern when assembling
 * object literals from a mix of present/absent values:
 *
 * ```ts
 * return {
 *   id: source.id,
 *   ...optional({ sessionName, firstMessage }),
 * };
 * ```
 *
 * The return type narrows each value's type to exclude `undefined`, so the
 * caller can still spread into a target shape with `exactOptionalPropertyTypes`
 * enabled.
 */
export function optional<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key in input) {
    const value = input[key];
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/**
 * Best-effort, user-facing error string. Handles `Error`, `DOMException`
 * (where `name` is sometimes more informative than the empty `message`),
 * and arbitrary thrown values without ever returning the literal
 * `"[object Object]"`.
 */
export function errorMessage(error: unknown): string {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.message || error.name;
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}
