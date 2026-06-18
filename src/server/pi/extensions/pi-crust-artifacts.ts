import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defaultArtifactFileRoots, encodeArtifactFilePath, resolveArtifactFile } from "../../artifact-file.js";

import { optional } from "../../../shared/util.js";
import { validatePresentationDeck } from "../../../presentations/schema.js";
import { prepareLocalPresentationAssets } from "../../../presentations/local-assets.js";
import type { PresentationDeck } from "../../../presentations/schema.js";

/**
 * Internal options for tests / future session-context plumbing. The tool
 * needs to know (sessionId, cwd) to compute the auto-copy target dir
 * `<cwd>/.pi/presentations/<sessionId>/`. In production we resolve this
 * via a `session_start` event handler that records the runtime session
 * id; tests inject a stub directly through this factory option.
 */
export interface PiRemoteArtifactsOptions {
  readonly getSessionContext?: () => { readonly sessionId: string; readonly cwd: string } | undefined;
}
const ARTIFACT_DETAIL_KEY = "piRemoteControlArtifact";
const ARTIFACT_SCHEMA_VERSION = 1;

const PRESENTATION_DETAIL_KIND = "presentation";

type SessionCreateResponse = {
  id?: string;
  sessionFile?: string;
};

export default function piRemoteArtifacts(pi: ExtensionAPI, options: PiRemoteArtifactsOptions = {}) {
  // Production wiring: capture the session id + cwd on session_start so
  // show_presentation can compute the auto-copy target directory. Tests
  // bypass this by passing options.getSessionContext directly.
  let sessionContext: { sessionId: string; cwd: string } | undefined;
  if (!options.getSessionContext) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onAny = (pi as any).on;
      if (typeof onAny === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onAny.call(pi, "session_start", (_event: unknown, ctx: any) => {
          const sid = ctx?.sessionManager?.getSessionId?.();
          const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
          if (typeof sid === "string" && sid && cwd) {
            sessionContext = { sessionId: sid, cwd };
          }
        });
      }
    } catch {
      // pi runtime doesn't expose `on` in some test harnesses; auto-copy
      // simply won't fire there.
    }
  }
  const getSessionContext = options.getSessionContext ?? (() => sessionContext);

  pi.registerTool({
    name: "show_artifact",
    label: "Show Artifact",
    description: "Display a rich artifact in the Pi Remote Control web UI. Use this for plots, generated images, HTML reports, markdown reports, JSON data, tables, and Vega-Lite charts that should be rendered for the user.",
    promptSnippet: "show_artifact displays images, HTML, markdown, JSON, tables, and Vega-Lite charts in the Pi Remote Control web UI.",
    promptGuidelines: [
      "Use show_artifact when you create an image, plot, table, report, or other visual result that the user should see in Pi Remote Control.",
      "For plots, prefer writing an image file or returning a Vega-Lite spec via show_artifact instead of pasting a long textual description.",
      "For HTML artifacts, keep the HTML self-contained; Pi Remote Control will render it in a browser sandbox.",
      "Use show_presentation or show_artifact kind=presentation when the user asks for a slide deck or presentation.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["image", "html", "markdown", "json", "table", "vega-lite", "presentation"] as const),
      title: Type.Optional(Type.String({ description: "Short display title for the artifact." })),
      path: Type.Optional(Type.String({ description: "Path to a generated artifact file, relative to cwd or absolute. Use for image/html files." })),
      mimeType: Type.Optional(Type.String({ description: "MIME type for path-backed artifacts, e.g. image/png or text/html." })),
      html: Type.Optional(Type.String({ description: "Self-contained HTML to render in a sandboxed iframe." })),
      markdown: Type.Optional(Type.String({ description: "Markdown content to render." })),
      data: Type.Optional(Type.Any({ description: "Structured artifact data, e.g. JSON, table rows, or Vega-Lite spec." })),
      alt: Type.Optional(Type.String({ description: "Alt text for image artifacts." })),
    }),
    async execute(_toolCallId, params) {
      // For file-backed artifact kinds (image, html), validate `path` up-front
      // so the tool call fails cleanly when the file doesn't exist or lives
      // outside the allow-list — mirroring how bash tool calls surface
      // errors. We also rewrite the path into a fetchable URL so the pi-crust
      // doesn't try to load /tmp/... as a relative URL against the host
      // origin (which falls through to the SPA index.html and shows a
      // broken image).
      let resolvedAbsPath: string | undefined;
      let resolvedUrl: string | undefined;
      let resolvedMimeType: string | undefined;
      let resolvedMarkdown: string | undefined;
      // `markdown` is file-backable too, but UNLIKE image/html it must be
      // INLINED rather than just URL-resolved: the web markdown renderer
      // (MessageTimeline -> ArtifactPreview) only renders when the detail
      // carries an inline `markdown` string — it never fetches a markdown
      // URL — so a bare `path` would fall through to the JSON fallback. We
      // only read the file when no inline `markdown` was supplied (inline
      // wins). The actual byte cap is handled downstream by
      // stripToolArtifactForTransport (which truncates + lazy-fetches large
      // inline strings), so we inline the full file here.
      const markdownNeedsFileBacking =
        params.kind === "markdown" &&
        typeof params.markdown !== "string" &&
        typeof params.path === "string" &&
        params.path.length > 0;
      const needsFileBacking =
        (params.kind === "image" || params.kind === "html" || markdownNeedsFileBacking) &&
        typeof params.path === "string" &&
        params.path.length > 0;
      if (needsFileBacking) {
        const absCandidate = path.isAbsolute(params.path as string)
          ? (params.path as string)
          : path.resolve(process.cwd(), params.path as string);
        const result = await resolveArtifactFile(absCandidate, {
          allowedRoots: defaultArtifactFileRoots([process.cwd()]),
        });
        if (!result.ok) {
          throw new Error(`show_artifact path is invalid: ${result.error}`);
        }
        resolvedAbsPath = result.resolution.absPath;
        resolvedUrl = `/api/artifact-file?path=${encodeArtifactFilePath(result.resolution.absPath)}`;
        resolvedMimeType = params.mimeType ?? result.resolution.mimeType;
        if (markdownNeedsFileBacking) {
          // Inline the file contents so the web renderer has the string it
          // needs. Read via the already-validated realPath to avoid a
          // TOCTOU re-resolution.
          resolvedMarkdown = await fs.readFile(result.resolution.realPath, "utf8");
        }
      }
      return {
        content: [{ type: "text", text: `Displayed ${params.kind} artifact${params.title ? `: ${params.title}` : ""}.` }],
        details: {
          [ARTIFACT_DETAIL_KEY]: {
            version: ARTIFACT_SCHEMA_VERSION,
            kind: params.kind,
            ...optional({ title: params.title }),
            ...(resolvedAbsPath !== undefined
              ? { path: resolvedAbsPath }
              : (params.path === undefined ? {} : { path: params.path })),
            ...optional({ url: resolvedUrl }),
            ...(resolvedMimeType !== undefined
              ? { mimeType: resolvedMimeType }
              : (params.mimeType === undefined ? {} : { mimeType: params.mimeType })),
            ...optional({ html: params.html }),
            ...optional({ markdown: resolvedMarkdown ?? params.markdown }),
            ...optional({ data: params.data }),
            ...optional({ alt: params.alt }),
          },
        },
      };
    },
  });

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

  pi.registerTool({
    name: "spawn_prc_session",
    label: "Spawn pi-crust Session",
    description: "Spawn a new Pi Remote Control session and kick it off with a prompt. Use this to delegate independent work to another visible pi-crust session.",
    promptSnippet: "spawn_prc_session creates a new Pi Remote Control session with a cwd/name and starts it with a prompt.",
    promptGuidelines: [
      "Use spawn_prc_session when the user explicitly asks to split work into independent Pi Remote Control sessions.",
      "Keep each spawned session narrowly scoped; include the exact task, cwd, constraints, and expected final report in the prompt.",
      "Do not use spawn_prc_session for routine subtasks unless the user asked for parallel/background sessions.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Initial prompt to send to the new session. Include the task scope and constraints." }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new session. Defaults to the current session cwd." })),
      sessionName: Type.Optional(Type.String({ description: "Display name for the new session in the pi-crust sidebar." })),
    }),
    async execute(_toolCallId, params) {
      const apiBase = resolvePiRemoteApiBase();
      const cwd = params.cwd?.trim() || process.cwd();
      const created = await postJson<SessionCreateResponse>(`${apiBase}/api/sessions`, {
        cwd,
        ...(params.sessionName?.trim() ? { sessionName: params.sessionName.trim() } : {}),
      });

      if (!created.id) {
        throw new Error("Pi Remote Control did not return a session id");
      }

      // Fire-and-forget: /prompt intentionally waits for the spawned agent turn
      // to finish. This tool should return as soon as the new session is
      // visible, so the parent session can keep working while the child works.
      void postJson(`${apiBase}/api/sessions/${encodeURIComponent(created.id)}/prompt`, {
        text: params.prompt,
      }).catch((error) => {
        console.error(
          `[spawn_prc_session] failed to send prompt to ${created.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const uiBase = resolvePiRemoteUiBase(apiBase);
      const sessionUrl = `${uiBase}/?session=${encodeURIComponent(created.id)}`;
      return {
        content: [{
          type: "text",
          text: `Spawned Pi Remote Control session ${created.id}${params.sessionName ? ` (${params.sessionName})` : ""}. Prompt delivery is running in the background. URL: ${sessionUrl}`,
        }],
        details: {
          spawnedPiRemoteControlSession: {
            version: 1,
            sessionId: created.id,
            ...optional({ sessionFile: created.sessionFile }),
            cwd,
            ...optional({ sessionName: params.sessionName }),
            url: sessionUrl,
          },
        },
      };
    },
  });
}

function slugifyDeckTitle(value: string): string {
  const slug = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "deck";
}

function resolvePiRemoteApiBase(): string {
  if (process.env.PI_CRUST_API_BASE) return trimTrailingSlash(process.env.PI_CRUST_API_BASE);
  const configuredHost = process.env.PI_CRUST_API_HOST ?? "127.0.0.1";
  const host = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
  const port = process.env.PI_CRUST_API_PORT ?? "8787";
  return `http://${host}:${port}`;
}

function resolvePiRemoteUiBase(apiBase: string): string {
  if (process.env.PI_CRUST_UI_BASE) return trimTrailingSlash(process.env.PI_CRUST_UI_BASE);
  return apiBase;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data
      ? String((data as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(`POST ${url} failed: ${message}`);
  }
  return data as T;
}
