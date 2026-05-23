/**
 * Defensive coercion for inputs to `react-markdown`.
 *
 * react-markdown's mdast/micromark pipeline calls `createFile(value)` where
 * `value` is asserted to be a string; if anything (a future codepath, a
 * malformed message payload, a stringified buffer that comes through as an
 * object) passes a non-string in, the assertion throws inside React's
 * render phase. Without an error boundary on the path, the *whole* tree
 * unmounts and the page goes blank — observed in production on
 * session 019e4de3-… where 556 messages were loading and one element in
 * the render tree produced a non-string for `children`.
 *
 * The right long-term fix is to find every place that constructs the
 * non-string and shape-check it at the source. In the meantime, every
 * `<ReactMarkdown>` call in the pi-crust goes through `coerceMarkdownInput`
 * which:
 *
 *   - returns strings unchanged (the common case);
 *   - JSON-stringifies objects/arrays so they at least render as text;
 *   - coerces other primitives via String();
 *   - never throws.
 *
 * We `console.warn` once per shape so a regression is loud in dev but
 * doesn't drown the console at scale.
 */

const SEEN_WARN_SHAPES = new Set<string>();

export function coerceMarkdownInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Object / array / function / symbol: stringify safely and warn.
  let rendered: string;
  try {
    rendered = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  } catch {
    rendered = "[unserializable]";
  }
  // Warn at most once per top-level constructor name so repeated bad payloads
  // don't spam the console.
  const shape = value && typeof value === "object"
    ? (Array.isArray(value) ? "Array" : (value as { constructor?: { name?: string } }).constructor?.name ?? "Object")
    : typeof value;
  if (!SEEN_WARN_SHAPES.has(shape)) {
    SEEN_WARN_SHAPES.add(shape);
    // eslint-disable-next-line no-console
    console.warn(
      `[markdown] non-string passed to <Markdown> (shape=${shape}); coercing to text. ` +
      `Find the call site and pass a string instead.`,
      value,
    );
  }
  return rendered;
}
