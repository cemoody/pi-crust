import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { slugify } from "../../../shared/util.js";
import { validatePresentationDeck } from "../../../presentations/schema.js";
import { prepareLocalPresentationAssets } from "../../../presentations/local-assets.js";
import type { PresentationDeck } from "../../../presentations/schema.js";
import { postJson, resolvePiRemoteApiBase } from "./pi-remote-api.js";

const ARTIFACT_DETAIL_KEY = "piRemoteControlArtifact";
const ARTIFACT_SCHEMA_VERSION = 1;
const PRESENTATION_DETAIL_KIND = "presentation";

type SessionContext = { readonly sessionId: string; readonly cwd: string };

/** Registers the deck display and template-discovery tools. */
export function registerPresentationTools(
  pi: ExtensionAPI,
  getSessionContext: () => SessionContext | undefined,
): void {
  pi.registerTool({
  name: "show_presentation",
  label: "Show Presentation",
  description: "Display a slide deck in Pi Remote Control. Pass `path`: the path to a JSON file containing the full deck spec ({ title, subtitle, theme, slides, ... }). Each slide can include template, title, subtitle, body, bullets, stats, images, columns, speaker notes, and fragments. To use a brand template pack, set `templatePack` on the deck (e.g. 'brainco') and `layout` + `slots` on each slide. The deck is read from the file — it is NOT passed inline.",
  promptSnippet: "show_presentation displays structured HTML slide decks with preview and present controls in Pi Remote Control. The deck spec is a JSON file referenced by `path`, not inline. Supports brand template packs via templatePack + layout + slots.",
  promptGuidelines: [
    "Use show_presentation when the user asks to create, revise, or present a slide deck.",
    "Write the full deck spec to a JSON file first (e.g. with the write tool), then call show_presentation with `path` pointing at that file. Do NOT inline the deck/slides into the tool call — this keeps large decks out of the conversation.",
    "The JSON file must contain a single object with at least `title` and a non-empty `slides` array; it may also set id, subtitle, theme, client, confidential, logo, and templatePack.",
    "Prefer structured deck data over raw HTML so Pi Remote Control can provide preview, present, download, and fallback outline behavior.",
    "Keep each slide concise: one main title, short bullets, optional stats/images, and speaker notes only when useful.",
    "If a brand template pack is configured (e.g. brainco), set templatePack on the deck and use layout + slots per slide instead of generic title/bullets fields. Layout keys and slot names are pack-specific.",
    "Image src must be an https:// URL, a data: URI, or a path RELATIVE to the session's .pi/presentations/<deckId>/ directory (no leading slash, no '..'). Absolute paths that point at real files inside the session's cwd are auto-copied into the right directory, so passing /path/to/chart.png is fine when the file exists — anything else is rejected with an actionable error.",
  ],
  parameters: Type.Object({
    path: Type.String({ description: "Path to a JSON file containing the full presentation deck spec ({ title, slides, ... }). Relative to the session cwd or absolute. The deck is read from this file; it is not passed inline." }),
  }),
  async execute(_toolCallId, params) {
    // The deck spec is read from a JSON file referenced by `path`. Inline
    // decks are intentionally not supported — they bloated tool calls with
    // tens of kB of JSON. Read + parse the file before doing anything else.
    const specPath = typeof params.path === "string" ? params.path.trim() : "";
    if (!specPath) {
      throw new Error(
        "show_presentation requires `path`: the path to a JSON file containing the deck spec " +
        "({ title, slides, ... }). Write the deck to a file first, then pass its path. " +
        "Inline decks (title/slides params) are no longer supported.",
      );
    }
    const absSpecPath = path.isAbsolute(specPath) ? specPath : path.resolve(process.cwd(), specPath);
    let rawSpec: string;
    try {
      rawSpec = await fs.readFile(absSpecPath, "utf8");
    } catch (error) {
      throw new Error(
        `show_presentation could not read the deck spec file at ${absSpecPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let spec: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawSpec);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`expected a JSON object { title, slides, ... } but got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
      }
      spec = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `show_presentation could not parse the deck spec file at ${absSpecPath} as JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const title = spec.title;
    const templatePack = spec.templatePack;
    // If the deck specifies a templatePack, pre-resolve each slide's layout
    // via the pi-crust template-pack route so the pi-crust receives slide.html
    // already baked. This keeps the pi-crust compile path synchronous.
    let slides = Array.isArray(spec.slides) ? (spec.slides as Array<Record<string, unknown>>) : [];
    if (typeof templatePack === "string" && templatePack.length > 0 && slides.length > 0) {
      const apiBase = resolvePiRemoteApiBase();
      slides = await Promise.all(
        slides.map(async (slide, index) => {
          const layout = typeof slide.layout === "string" ? slide.layout : undefined;
          if (!layout || typeof slide.html === "string") return slide;
          const slots = { page: index + 1, ...(slide.slots as Record<string, unknown> | undefined ?? {}) };
          try {
            const url = `${apiBase}/api/presentations/templates/${encodeURIComponent(templatePack)}/render/${encodeURIComponent(layout)}`;
            const response = await postJson<{ readonly html?: string }>(url, { slots });
            if (response && typeof response.html === "string") return { ...slide, html: response.html };
          } catch {
            // Fall through and leave slide as-is; pi-crust will show the generic outline.
          }
          return slide;
        }),
      );
    }
    const deckId = typeof spec.id === "string" && spec.id.trim().length > 0
      ? spec.id.trim()
      : slugifyDeckTitle(typeof title === "string" ? title : "");
    let deck: PresentationDeck = {
      ...spec,
      id: deckId,
      slides,
    } as unknown as PresentationDeck;
    // Auto-copy any absolute image.src / logo.src that points at a real
    // file inside the session's cwd into
    // `<cwd>/.pi/presentations/<sessionId>/`, then rewrite to a bare
    // filename. Anything we can't safely resolve is left untouched so
    // the validator below surfaces the actionable error from #166.
    const ctx = getSessionContext();
    if (ctx) {
      const targetDir = path.join(ctx.cwd, ".pi", "presentations", ctx.sessionId);
      const prepared = await prepareLocalPresentationAssets(deck, { cwd: ctx.cwd, targetDir });
      deck = prepared.deck;
    }
    // Validate the assembled deck before returning success. Without this
    // check, structural errors (e.g. `image` passed as a string, missing
    // `image.src`, bullets as a non-array, etc.) only surface in the web
    // client as an "Invalid presentation" card — the model thinks the call
    // succeeded and has no signal to self-correct. Throwing here turns the
    // tool call into a normal error the LLM can read and fix on the next
    // turn. The message lists every concrete error plus a one-line shape
    // hint so the model knows what valid input looks like.
    const validation = validatePresentationDeck(deck);
    if (!validation.ok) {
      const errors = validation.errors.map((e) => `  - ${e}`).join("\n");
      throw new Error(
        `show_presentation rejected the deck because it has ${validation.errors.length} validation error${validation.errors.length === 1 ? "" : "s"}:\n${errors}\n\n` +
        `Expected slide shape (all fields optional unless noted): {\n` +
        `  template?: "title" | "bullets" | "stats" | "quote" | "columns" | "image" | string,\n` +
        `  title?: string, subtitle?: string, eyebrow?: string, body?: string,\n` +
        `  quote?: string, attribution?: string,\n` +
        `  bullets?: (string | { text: string, detail?: string })[],\n` +
        `  stats?: { value: string, label?: string }[],\n` +
        `  columns?: { title?: string, body?: string, bullets?: ... }[],\n` +
        `  image?: { src: string, alt?: string },   // object, not a string\n` +
        `  notes?: string, fragments?: string[],\n` +
        `  layout?: string, slots?: Record<string, string | number | null>\n` +
        `}\nFix the listed fields and call show_presentation again.`,
      );
    }
    const slideCount = deck.slides.length;
    return {
      content: [{ type: "text", text: `Displayed presentation deck: ${deck.title} (${slideCount} slide${slideCount === 1 ? "" : "s"}).` }],
      details: {
        [ARTIFACT_DETAIL_KEY]: {
          version: ARTIFACT_SCHEMA_VERSION,
          kind: PRESENTATION_DETAIL_KIND,
          title: deck.title,
          deckId,
          data: deck,
        },
      },
    };
  },
});

pi.registerTool({
  name: "list_presentation_templates",
  label: "List Presentation Templates",
  description: "List every template pack configured in pi-crust and the layout keys each pack exposes. Use this before authoring a deck so you know which (templatePack, layout) values are valid. Returns { packs: [{ id, name, version?, dir, layouts: string[] }] }.",
  promptSnippet: "list_presentation_templates lists template packs registered via presentations.templateDirs (e.g. brainco). Call before show_presentation when authoring brand-template decks.",
  promptGuidelines: [
    "Use list_presentation_templates whenever the user asks for a slide deck and you don't already know which template packs / layouts exist.",
    "Pick a layout key from the returned list and pass it as `layout` on each slide in show_presentation, along with the matching `templatePack` on the deck.",
    "If the list is empty, fall back to the generic deck schema in show_presentation (no templatePack, slides use template/title/bullets/etc.).",
  ],
  parameters: Type.Object({}),
  async execute() {
    const apiBase = resolvePiRemoteApiBase();
    const result = await getJson<{ packs?: Array<Record<string, unknown>> }>(`${apiBase}/api/presentations/templates`);
    const packs = Array.isArray(result?.packs) ? result.packs : [];
    const summary = packs.length === 0
      ? "No template packs are configured. Add a directory via presentations.templateDirs in Settings, or author with the generic deck schema."
      : packs.map((p) => `${p.id ?? "?"}: ${(p.layouts as readonly unknown[] | undefined)?.length ?? 0} layout(s)`).join("; ");
    return {
      content: [{ type: "text", text: `Template packs available — ${summary}` }],
      details: { packs },
    };
  },
});
}

function slugifyDeckTitle(value: string): string {
  return slugify(value, "deck");
}

async function getJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url, { method: "GET", headers: { "Accept": "application/json" } });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data
      ? String((data as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(`GET ${url} failed: ${message}`);
  }
  return data as T;
}
