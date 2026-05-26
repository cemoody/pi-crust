import { isRecord } from "../shared/util.js";

export const PRESENTATION_MIME = "application/vnd.pi.presentation+json";

export interface PresentationDeck {
  /** Optional stable identifier used as the filename component for
   *  per-session persisted edits (`<deckId>.deck.json`). The
   *  `show_presentation` tool assigns a slug of the title when omitted. */
  readonly id?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly theme?: "light" | "dark" | string;
  readonly client?: string;
  readonly date?: string;
  readonly confidential?: string;
  readonly logo?: PresentationImage;
  readonly slides: readonly PresentationSlide[];
  /** Optional template-pack id (e.g. "brainco"). When set, slides that
   *  specify a `layout` are pre-rendered by that pack via the host
   *  extension's template-pack API and injected via `slide.html`. */
  readonly templatePack?: string;
}

export interface PresentationSlide {
  readonly id?: string;
  readonly template?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly eyebrow?: string;
  readonly body?: string;
  readonly quote?: string;
  readonly attribution?: string;
  readonly bullets?: readonly (string | PresentationBullet)[];
  readonly stats?: readonly PresentationStat[];
  readonly image?: PresentationImage;
  readonly columns?: readonly PresentationSlideColumn[];
  readonly notes?: string;
  readonly fragments?: readonly string[];
  /**
   * Optional raw HTML body for the slide. When present, the deck compiler
   * bypasses template-based rendering and uses this HTML directly inside
   * the slide container. Used by template-pack extensions (e.g. private
   * brand packs) that ship their own calibrated layouts.
   */
  readonly html?: string;
  /** Optional layout key inside the deck's templatePack (e.g. "title-light").
   *  Resolved to HTML at render time; ignored when slide.html is already
   *  provided. */
  readonly layout?: string;
  /** Slot values for the chosen layout (e.g. { primary: "Q4", secondary: "..." }). */
  readonly slots?: Readonly<Record<string, string | number | null | undefined>>;
}

export interface PresentationBullet {
  readonly text: string;
  readonly detail?: string;
}

export interface PresentationStat {
  readonly value: string;
  readonly label?: string;
}

export interface PresentationImage {
  readonly src: string;
  readonly alt?: string;
  readonly resolve?: "embed" | "url" | "copy";
}

export interface PresentationSlideColumn {
  readonly title?: string;
  readonly body?: string;
  readonly bullets?: readonly (string | PresentationBullet)[];
}

export interface PresentationValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function validatePresentationDeck(value: unknown): PresentationValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["deck must be an object"] };
  if (!nonEmptyString(value.title)) errors.push("title is required");
  if (isRecord(value.logo)) {
    if (!nonEmptyString(value.logo.src)) {
      errors.push("logo.src is required");
    } else {
      const unsafe = describeUnsafeAssetPath(value.logo.src);
      if (unsafe) errors.push(`logo.src ${unsafe}`);
    }
  }
  if (!Array.isArray(value.slides) || value.slides.length === 0) {
    errors.push("slides must be a non-empty array");
  } else {
    value.slides.forEach((slide, index) => validateSlide(slide, index, errors));
  }
  return { ok: errors.length === 0, errors };
}

export function coercePresentationDeck(value: unknown): PresentationDeck {
  const validation = validatePresentationDeck(value);
  if (!validation.ok) throw new Error(`Invalid presentation deck: ${validation.errors.join("; ")}`);
  return value as PresentationDeck;
}

function validateSlide(value: unknown, index: number, errors: string[]) {
  if (!isRecord(value)) {
    errors.push(`slides[${index}] must be an object`);
    return;
  }
  const hasContent = [value.title, value.subtitle, value.body, value.quote, value.html].some(nonEmptyString)
    || (Array.isArray(value.bullets) && value.bullets.length > 0)
    || (Array.isArray(value.columns) && value.columns.length > 0)
    || (Array.isArray(value.stats) && value.stats.length > 0)
    || isRecord(value.image)
    || nonEmptyString(value.layout);
  if (!hasContent) {
    errors.push(`slides[${index}] must contain visible content (set at least one of: title, subtitle, body, quote, bullets, stats, columns, image, html, or layout)`);
  }
  if (value.bullets !== undefined && !Array.isArray(value.bullets)) {
    errors.push(`slides[${index}].bullets must be an array of strings or { text, detail? } objects`);
  }
  if (value.columns !== undefined && !Array.isArray(value.columns)) {
    errors.push(`slides[${index}].columns must be an array of { title?, body?, bullets? } objects`);
  }
  if (value.stats !== undefined && !Array.isArray(value.stats)) {
    errors.push(`slides[${index}].stats must be an array of { value, label? } objects`);
  }
  if (value.image !== undefined) {
    if (typeof value.image === "string") {
      errors.push(`slides[${index}].image must be an object like { src: "path-or-url", alt? } — got a string. Did you mean { src: ${JSON.stringify(value.image)} }?`);
    } else if (!isRecord(value.image)) {
      errors.push(`slides[${index}].image must be an object like { src: "path-or-url", alt? } — got ${describeType(value.image)}`);
    } else if (!nonEmptyString(value.image.src)) {
      errors.push(`slides[${index}].image.src is required and must be a non-empty string (got ${describeType(value.image.src)})`);
    } else {
      const unsafe = describeUnsafeAssetPath(value.image.src);
      if (unsafe) errors.push(`slides[${index}].image.src ${unsafe}`);
    }
  }
  if (value.slots !== undefined && !isRecord(value.slots)) {
    errors.push(`slides[${index}].slots must be an object mapping slot name → string/number/null`);
  }
  if (value.template !== undefined && !nonEmptyString(value.template)) {
    errors.push(`slides[${index}].template must be a non-empty string when set`);
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Mirror of the runtime rule in src/presentations/assets.ts so the LLM gets
// an actionable validation error at tool-call time instead of a render-time
// 'Unsafe presentation asset path' card it can't see. Returns a remediation
// fragment ('is unsafe (...): ...') or undefined when the path is fine.
const ASSET_DATA_URI_PATTERN = /^data:/i;
const ASSET_REMOTE_URL_PATTERN = /^https?:\/\//i;
const ASSET_ABSOLUTE_OR_SCHEME_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;
export function describeUnsafeAssetPath(src: string): string | undefined {
  if (ASSET_DATA_URI_PATTERN.test(src)) return undefined;
  if (ASSET_REMOTE_URL_PATTERN.test(src)) return undefined;
  const hint = `must be one of: an https:// URL, a data: URI, or a path RELATIVE to the session's .pi/presentations/<deckId>/ directory (no leading slash, no ".."). Save the file into that directory first (e.g. with the file-writing tool) and pass just the filename, e.g. "chart.png".`;
  if (ASSET_ABSOLUTE_OR_SCHEME_PATTERN.test(src)) {
    return `is unsafe (${JSON.stringify(src)} is an absolute path or non-http(s) scheme): ${hint}`;
  }
  if (src.split(/[\\/]+/).some((part) => part === "..")) {
    return `is unsafe (${JSON.stringify(src)} contains ".." path traversal): ${hint}`;
  }
  return undefined;
}

export function isPresentationDeck(value: unknown): value is PresentationDeck {
  return validatePresentationDeck(value).ok;
}

export function presentationFallbackMarkdown(deck: PresentationDeck): string {
  const lines = [`# ${deck.title}`];
  if (deck.subtitle) lines.push("", deck.subtitle);
  deck.slides.forEach((slide, index) => {
    lines.push("", `## ${index + 1}. ${slide.title ?? slide.template ?? "Slide"}`);
    if (slide.subtitle) lines.push("", slide.subtitle);
    if (slide.body) lines.push("", slide.body);
    if (slide.quote) lines.push("", `> ${slide.quote}`);
    if (slide.attribution) lines.push(`> — ${slide.attribution}`);
    for (const bullet of slide.bullets ?? []) {
      if (typeof bullet === "string") lines.push(`- ${bullet}`);
      else {
        lines.push(`- ${bullet.text}`);
        if (bullet.detail) lines.push(`  - ${bullet.detail}`);
      }
    }
    for (const stat of slide.stats ?? []) lines.push(`- **${stat.value}**${stat.label ? ` — ${stat.label}` : ""}`);
  });
  return lines.join("\n");
}


function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
