import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const ARTIFACT_DETAIL_KEY = "piRemoteControlArtifact";
const ARTIFACT_SCHEMA_VERSION = 1;

const PRESENTATION_DETAIL_KIND = "presentation";

type SessionCreateResponse = {
  id?: string;
  sessionFile?: string;
};

export default function piRemoteArtifacts(pi: ExtensionAPI) {
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
      return {
        content: [{ type: "text", text: `Displayed ${params.kind} artifact${params.title ? `: ${params.title}` : ""}.` }],
        details: {
          [ARTIFACT_DETAIL_KEY]: {
            version: ARTIFACT_SCHEMA_VERSION,
            kind: params.kind,
            ...(params.title === undefined ? {} : { title: params.title }),
            ...(params.path === undefined ? {} : { path: params.path }),
            ...(params.mimeType === undefined ? {} : { mimeType: params.mimeType }),
            ...(params.html === undefined ? {} : { html: params.html }),
            ...(params.markdown === undefined ? {} : { markdown: params.markdown }),
            ...(params.data === undefined ? {} : { data: params.data }),
            ...(params.alt === undefined ? {} : { alt: params.alt }),
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "show_presentation",
    label: "Show Presentation",
    description: "Display a slide deck in Pi Remote Control. Accepts a structured deck with title and slides; slides can include title, subtitle, body, bullets, stats, images, columns, speaker notes, and fragments.",
    promptSnippet: "show_presentation displays structured HTML slide decks with preview and present controls in Pi Remote Control.",
    promptGuidelines: [
      "Use show_presentation when the user asks to create, revise, or present a slide deck.",
      "Prefer structured deck data over raw HTML so Pi Remote Control can provide preview, present, download, and fallback outline behavior.",
      "Keep each slide concise: one main title, short bullets, optional stats/images, and speaker notes only when useful.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Deck title." }),
      subtitle: Type.Optional(Type.String({ description: "Optional deck subtitle." })),
      theme: Type.Optional(Type.String({ description: "Theme name, e.g. brainco, light, dark." })),
      client: Type.Optional(Type.String({ description: "Client or audience label." })),
      confidential: Type.Optional(Type.String({ description: "Footer confidentiality text." })),
      slides: Type.Array(Type.Any({ description: "Slide objects. Each slide can include template, title, subtitle, body, bullets, stats, image, columns, notes, and fragments." }), { minItems: 1 }),
    }),
    async execute(_toolCallId, params) {
      const deck = {
        title: params.title,
        ...(params.subtitle === undefined ? {} : { subtitle: params.subtitle }),
        ...(params.theme === undefined ? {} : { theme: params.theme }),
        ...(params.client === undefined ? {} : { client: params.client }),
        ...(params.confidential === undefined ? {} : { confidential: params.confidential }),
        slides: params.slides,
      };
      return {
        content: [{ type: "text", text: `Displayed presentation deck: ${params.title} (${params.slides.length} slide${params.slides.length === 1 ? "" : "s"}).` }],
        details: {
          [ARTIFACT_DETAIL_KEY]: {
            version: ARTIFACT_SCHEMA_VERSION,
            kind: PRESENTATION_DETAIL_KIND,
            title: params.title,
            data: deck,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "spawn_prc_session",
    label: "Spawn PRC Session",
    description: "Spawn a new Pi Remote Control session and kick it off with a prompt. Use this to delegate independent work to another visible PRC session.",
    promptSnippet: "spawn_prc_session creates a new Pi Remote Control session with a cwd/name and starts it with a prompt.",
    promptGuidelines: [
      "Use spawn_prc_session when the user explicitly asks to split work into independent Pi Remote Control sessions.",
      "Keep each spawned session narrowly scoped; include the exact task, cwd, constraints, and expected final report in the prompt.",
      "Do not use spawn_prc_session for routine subtasks unless the user asked for parallel/background sessions.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Initial prompt to send to the new session. Include the task scope and constraints." }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new session. Defaults to the current session cwd." })),
      sessionName: Type.Optional(Type.String({ description: "Display name for the new session in the PRC sidebar." })),
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
            ...(created.sessionFile === undefined ? {} : { sessionFile: created.sessionFile }),
            cwd,
            ...(params.sessionName === undefined ? {} : { sessionName: params.sessionName }),
            url: sessionUrl,
          },
        },
      };
    },
  });
}

function resolvePiRemoteApiBase(): string {
  if (process.env.PI_REMOTE_API_BASE) return trimTrailingSlash(process.env.PI_REMOTE_API_BASE);
  const configuredHost = process.env.PI_REMOTE_API_HOST ?? "127.0.0.1";
  const host = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
  const port = process.env.PI_REMOTE_API_PORT ?? "8787";
  return `http://${host}:${port}`;
}

function resolvePiRemoteUiBase(apiBase: string): string {
  if (process.env.PI_REMOTE_UI_BASE) return trimTrailingSlash(process.env.PI_REMOTE_UI_BASE);
  return apiBase;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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
