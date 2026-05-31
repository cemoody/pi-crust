/**
 * Single home for the 12+ hand-rolled inline SVG glyphs that were scattered
 * across SessionDashboard, MessageTimeline, and PromptComposer. Each glyph
 * was its own zero-arg component with a copy-pasted <svg> header; this
 * collapses them onto one <Icon name="..." /> renderer driven by a paths
 * registry. The strokeWidth/fill/viewBox conventions are preserved per glyph.
 *
 * Call-site wrappers (CopyGlyph, FilterGlyph, etc.) stay where they were —
 * they're now one-liners delegating here, so the existing JSX (<CopyGlyph />)
 * keeps working without changes.
 */
import type { JSX } from "react";

export type IconName =
  | "copy"
  | "more"
  | "send"
  | "stop"
  | "paperclip"
  | "filter"
  | "fork"
  | "clone"
  | "pencil"
  | "trash"
  | "sidebar-toggle"
  | "new-session"
  | "cron"
  | "terminal"
  | "extension";

interface IconSpec {
  readonly width: number;
  readonly height: number;
  /** Optional viewBox override; defaults to "0 0 16 16". */
  readonly viewBox?: string;
  /** When set, the svg uses fill=currentColor and no stroke (icon-as-shape).
   *  Otherwise the icon is line-art: stroke=currentColor, strokeWidth=1.5,
   *  fill=none, with round line caps and joins. */
  readonly filled?: boolean;
  /** Override the default 1.5 stroke width (line-art icons only). */
  readonly strokeWidth?: number;
  readonly body: JSX.Element;
}

const ICONS: Record<IconName, IconSpec> = {
  copy: {
    width: 13, height: 13, strokeWidth: 1.4,
    body: <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M11.5 5.5V4A1.5 1.5 0 0 0 10 2.5H4A1.5 1.5 0 0 0 2.5 4v6A1.5 1.5 0 0 0 4 11.5h1.5" />
    </>,
  },
  more: {
    width: 13, height: 13, filled: true,
    body: <>
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </>,
  },
  send: {
    width: 14, height: 14,
    body: <>
      <path d="M13 4v4a3 3 0 0 1-3 3H3.5" />
      <path d="M6 8.5 3 11l3 2.5" />
    </>,
  },
  stop: {
    width: 12, height: 12, viewBox: "0 0 12 12", filled: true,
    body: <rect x="1" y="1" width="10" height="10" rx="2.5" />,
  },
  paperclip: {
    width: 14, height: 14,
    body: <path d="M12.5 6.5 7.4 11.6a2.2 2.2 0 1 1-3.1-3.1l5.6-5.6a3.3 3.3 0 0 1 4.7 4.7l-6 6a4.4 4.4 0 0 1-6.2-6.2L7.6 2.6" />,
  },
  filter: {
    width: 14, height: 14,
    body: <>
      <path d="M2 4h12" />
      <path d="M4 8h8" />
      <path d="M6 12h4" />
    </>,
  },
  fork: {
    width: 14, height: 14,
    body: <>
      <circle cx="4.5" cy="3.5" r="1.4" />
      <circle cx="4.5" cy="12.5" r="1.4" />
      <circle cx="11.5" cy="6.5" r="1.4" />
      <path d="M4.5 5v6" />
      <path d="M4.5 9c0-2 2-3 4-3h1.5" />
    </>,
  },
  clone: {
    width: 14, height: 14,
    body: <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h6" />
    </>,
  },
  pencil: {
    width: 14, height: 14,
    body: <>
      <path d="M10.5 2.5l3 3-8 8H2.5V10.5z" />
      <path d="M9 4l3 3" />
    </>,
  },
  trash: {
    width: 14, height: 14,
    body: <>
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2" />
      <path d="M7 7.5v4" />
      <path d="M9 7.5v4" />
    </>,
  },
  "sidebar-toggle": {
    width: 16, height: 16,
    body: <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <line x1="6" y1="3" x2="6" y2="13" />
    </>,
  },
  "new-session": {
    width: 14, height: 14,
    body: <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M8 5.5v5" />
      <path d="M5.5 8h5" />
    </>,
  },
  cron: {
    width: 14, height: 14,
    body: <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>,
  },
  extension: {
    width: 14, height: 14,
    body: <>
      <path d="M6.5 2.5h3" />
      <path d="M6.5 13.5h3" />
      <path d="M2.5 6.5v3" />
      <path d="M13.5 6.5v3" />
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
      <path d="M7 7h2v2H7z" />
    </>,
  },
  terminal: {
    width: 14, height: 14,
    body: <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M4.5 6.5 6.5 8l-2 1.5" />
      <path d="M8 9.5h3" />
    </>,
  },
};

export function Icon({ name }: { readonly name: IconName }): JSX.Element {
  const spec = ICONS[name];
  const common = {
    width: spec.width,
    height: spec.height,
    viewBox: spec.viewBox ?? "0 0 16 16",
    "aria-hidden": true as const,
  };
  if (spec.filled) {
    return <svg {...common} fill="currentColor">{spec.body}</svg>;
  }
  return (
    <svg
      {...common}
      fill="none"
      stroke="currentColor"
      strokeWidth={spec.strokeWidth ?? 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {spec.body}
    </svg>
  );
}
