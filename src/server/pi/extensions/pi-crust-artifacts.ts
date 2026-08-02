import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defaultArtifactFileRoots, encodeArtifactFilePath, resolveArtifactFile } from "../../artifact-file.js";

import { isRecord, optional } from "../../../shared/util.js";
import { registerPresentationTools } from "./presentation-tools.js";
import { postJson, resolvePiRemoteApiBase, resolvePiRemoteUiBase } from "./pi-remote-api.js";

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


type SessionCreateResponse = {
  id?: string;
  sessionFile?: string;
};

type SpawnPromptResponse = unknown;

type SubagentResultSummary = {
  readonly messages?: unknown;
  readonly messageCount?: number;
  readonly lastAssistantMessage?: string;
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

  registerPresentationTools(pi, getSessionContext);

  pi.registerTool({
    name: "prompt_prc_session",
    label: "Prompt pi-crust Session",
    description: "Send a new prompt to an existing Pi Remote Control session and wait for that agent turn to finish. Use this to continue, redirect, or request a result from a session that already exists; use spawn_prc_session only when a new independent session is required.",
    promptSnippet: "prompt_prc_session sends a new prompt to an existing Pi Remote Control session by session ID and returns that session's completed turn.",
    promptGuidelines: [
      "Use prompt_prc_session to continue or redirect an existing Pi Remote Control session instead of spawning a duplicate session.",
      "Pass the exact sessionId returned by spawn_prc_session or shown in the session URL.",
      "This tool waits for the prompted session's turn to finish. Use spawn_prc_session for a new independent background session.",
    ],
    parameters: Type.Object({
      sessionId: Type.String({ description: "ID of the existing Pi Remote Control session to prompt. This is the session ID returned by spawn_prc_session or shown in its URL." }),
      prompt: Type.String({ description: "The new prompt to deliver to the existing session." }),
    }),
    async execute(_toolCallId, params, signal?: AbortSignal) {
      const sessionId = params.sessionId.trim();
      if (!sessionId) throw new Error("prompt_prc_session requires a non-empty sessionId");
      const apiBase = resolvePiRemoteApiBase();
      const promptResult = await postJson<SpawnPromptResponse>(
        `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
        { text: params.prompt },
        { signal },
      );
      const result = summarizeSubagentResult(promptResult);
      const lastAssistant = result.lastAssistantMessage;
      const sessionUrl = `${resolvePiRemoteUiBase(apiBase)}/?session=${encodeURIComponent(sessionId)}`;
      return {
        content: [{
          type: "text",
          text: `Prompted Pi Remote Control session ${sessionId}. URL: ${sessionUrl}${lastAssistant ? `\n\n${lastAssistant}` : ""}`,
        }],
        details: {
          promptedPiRemoteControlSession: {
            version: 1,
            sessionId,
            url: sessionUrl,
            promptDelivery: "completed",
            result,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "spawn_prc_session",
    label: "Spawn pi-crust Session",
    description: "Spawn a new Pi Remote Control session and kick it off with a prompt. Use this to delegate independent work to another visible pi-crust session, or set subagent=true to wait for a child agent and return its results to the caller session.",
    promptSnippet: "spawn_prc_session creates a new Pi Remote Control session with a cwd/name and starts it with a prompt; set subagent=true when the caller needs the child agent's completed result returned.",
    promptGuidelines: [
      "Use spawn_prc_session when the user explicitly asks to split work into independent Pi Remote Control sessions.",
      "Keep each spawned session narrowly scoped; include the exact task, cwd, constraints, and expected final report in the prompt.",
      "Leave subagent unset/false for wholesale background sessions that should keep running independently.",
      "Set subagent=true when you need a child agent to complete a scoped task and return its session result to the caller session.",
      "Do not use spawn_prc_session for routine subtasks unless the user asked for parallel/background sessions or a subagent.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Initial prompt to send to the new session. Include the task scope and constraints." }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new session. Defaults to the current session cwd." })),
      sessionName: Type.Optional(Type.String({ description: "Display name for the new session in the pi-crust sidebar." })),
      subagent: Type.Optional(Type.Boolean({ description: "When true, wait for the spawned session prompt to finish and return the child agent's result to the caller. Defaults to false/background wholesale session." })),
    }),
    async execute(_toolCallId, params, signal?: AbortSignal) {
      const apiBase = resolvePiRemoteApiBase();
      const cwd = params.cwd?.trim() || process.cwd();
      const subagent = params.subagent === true;
      const created = await postJson<SessionCreateResponse>(`${apiBase}/api/sessions`, {
        cwd,
        ...(params.sessionName?.trim() ? { sessionName: params.sessionName.trim() } : {}),
        ...(subagent ? { subagent: true, hiddenFromList: true } : {}),
      }, { signal });

      const childSessionId = created.id;
      if (!childSessionId) {
        throw new Error("Pi Remote Control did not return a session id");
      }

      const promptUrl = `${apiBase}/api/sessions/${encodeURIComponent(childSessionId)}/prompt`;
      const promptBody = { text: params.prompt };
      const uiBase = resolvePiRemoteUiBase(apiBase);
      const sessionUrl = `${uiBase}/?session=${encodeURIComponent(childSessionId)}`;
      // A Pi abort only asks tools to stop through this signal; it cannot
      // forcibly settle an arbitrary promise. Propagate it to the child
      // delivery request *and* abort the child agent, otherwise a parent
      // session remains stuck waiting for a subagent tool call and the child
      // keeps running after the user presses Stop.
      const stopChild = () => {
        void postJson(`${apiBase}/api/sessions/${encodeURIComponent(childSessionId)}/abort`, {})
          .catch(() => undefined);
      };
      if (signal?.aborted) stopChild();
      else signal?.addEventListener("abort", stopChild, { once: true });

      if (subagent) {
        try {
          const promptResult = await postJson<SpawnPromptResponse>(promptUrl, promptBody, { signal });
          const subagentResult = summarizeSubagentResult(promptResult);
          const lastAssistant = subagentResult.lastAssistantMessage;
          return {
            content: [{
              type: "text",
              text: `Subagent session ${created.id}${params.sessionName ? ` (${params.sessionName})` : ""} completed. URL: ${sessionUrl}${lastAssistant ? `\n\n${lastAssistant}` : ""}`,
            }],
            details: {
              spawnedPiRemoteControlSession: {
                version: 1,
                sessionId: created.id,
                ...optional({ sessionFile: created.sessionFile }),
                cwd,
                ...optional({ sessionName: params.sessionName }),
                url: sessionUrl,
                subagent: true,
                promptDelivery: "completed",
                subagentResult,
              },
            },
          };
        } finally {
          signal?.removeEventListener("abort", stopChild);
        }
      }

      // Fire-and-forget: /prompt intentionally waits for the spawned agent turn
      // to finish. For wholesale sessions this tool should return as soon as
      // the new session is visible, so the parent session can keep working
      // while the child works independently.
      void postJson(promptUrl, promptBody, { signal })
        .catch((error) => {
          // Cancellation is intentional: stopChild() above has already
          // requested that the child session abort. Do not turn it into a
          // misleading server-side error log.
          if (signal?.aborted) return;
          console.error(
            `[spawn_prc_session] failed to send prompt to ${created.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => signal?.removeEventListener("abort", stopChild));

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
            subagent: false,
            promptDelivery: "background",
          },
        },
      };
    },
  });
}

function summarizeSubagentResult(promptResult: SpawnPromptResponse): SubagentResultSummary {
  const messages = Array.isArray(promptResult) ? promptResult : undefined;
  const lastAssistantMessage = messages
    ? findLastAssistantMessage(messages)
    : undefined;
  return {
    ...(messages ? { messages, messageCount: messages.length } : {}),
    ...optional({ lastAssistantMessage }),
  };
}

function findLastAssistantMessage(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role !== "assistant") continue;
    const text = extractMessageText(message);
    if (text) return text;
  }
  return undefined;
}

function extractMessageText(message: Record<string, unknown>): string | undefined {
  const candidates = [message.text, message.content, message.markdown];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}
