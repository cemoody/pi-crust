export interface TruncationResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

/**
 * Shortens text for compact UI labels, reserving the final character for an
 * ellipsis when truncation is needed.
 */
export function truncateWithEllipsis(text: string, maxChars: number): string {
  if (maxChars < 0) throw new Error("maxChars must be >= 0");
  if (text.length <= maxChars) return text;
  if (maxChars === 0) return "";
  return `${text.slice(0, maxChars - 1)}…`;
}

export function truncateText(text: string, maxChars: number): TruncationResult {
  if (maxChars < 0) throw new Error("maxChars must be >= 0");
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
  if (maxChars === 0) return { text: "", truncated: true, originalLength: text.length };
  const suffix = `\n… truncated ${text.length - maxChars} chars`;
  if (suffix.length >= maxChars) {
    return { text: text.slice(0, maxChars), truncated: true, originalLength: text.length };
  }
  return {
    text: `${text.slice(0, maxChars - suffix.length)}${suffix}`,
    truncated: true,
    originalLength: text.length,
  };
}
