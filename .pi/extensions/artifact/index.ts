/**
 * pi-remote-control artifact extension.
 *
 * Registers a `display` tool that the LLM calls to surface inline images
 * (Phase A), sandboxed HTML/D3 (Phase B), and declarative charts (Phase C) in
 * the web client's timeline.
 *
 * The tool never receives raw bytes through its arguments — the LLM passes a
 * file path on disk (preferred for images/plots produced by python, etc.) or a
 * compact spec object. The extension materializes the bytes into the per-
 * session artifact store and emits a `custom` message carrying a MIME-tagged
 * artifact envelope. The LLM's own tool-result text stays short (one line) so
 * we don't bloat the context window with rendered bytes.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  ARTIFACT_CUSTOM_TYPE,
  ARTIFACT_SCHEMA_VERSION,
  type ArtifactMessageDetails,
  type ArtifactRepresentation,
} from "../../../src/shared/artifact.js";
import { ArtifactStore, ArtifactStoreError } from "./artifact-store.js";

const SUPPORTED_IMAGE_EXTS: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "display",
    label: "Display",
    description:
      "Display an inline artifact (image / plot) in the user's web view. " +
      "Call this immediately after saving a chart or image to disk so the user sees it inline.",
    promptSnippet:
      "Display an inline image artifact (chart, plot, screenshot) in the web view by passing its file path.",
    promptGuidelines: [
      "Call display(path=...) immediately after saving a plot or chart so the user sees it inline.",
      "Do not base64-encode images into display arguments. Save to a file under the project cwd and pass its path.",
      "If display fails with size_cap, downscale the image before retrying.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Relative or absolute path to an image file under the project cwd. Supported types: png, jpg, jpeg, webp, gif.",
      }),
      caption: Type.Optional(
        Type.String({ description: "Optional short caption shown above the artifact." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "";
      const sessionId = sessionIdFromFile(sessionFile);
      if (!sessionId) {
        return errorResult("display: cannot render artifact in an ephemeral session (no session file).");
      }

      const ext = path.extname(params.path).toLowerCase();
      const mime = SUPPORTED_IMAGE_EXTS[ext];
      if (!mime) {
        return errorResult(
          `display: unsupported image extension ${ext || "<none>"}. Supported: ${Object.keys(SUPPORTED_IMAGE_EXTS).join(", ")}.`,
        );
      }

      const store = new ArtifactStore({ cwd, sessionId });
      let stored;
      try {
        stored = await store.put({ mime, sourcePath: params.path });
      } catch (error) {
        if (error instanceof ArtifactStoreError) {
          return errorResult(`display: ${error.message} (${error.code})`);
        }
        throw error;
      }

      const basename = path.basename(params.path);
      const fallbackText = params.caption
        ? `${params.caption} (${basename}, ${formatBytes(stored.bytes)})`
        : `Image: ${basename} (${formatBytes(stored.bytes)})`;

      const reps: ArtifactRepresentation[] = [
        {
          mime: stored.mime as ArtifactRepresentation["mime"],
          src: { kind: "url", url: stored.relativeUrl },
          alt: params.caption ?? basename,
          bytes: stored.bytes,
        } as ArtifactRepresentation,
        { mime: "text/plain", text: fallbackText },
      ];

      const details: ArtifactMessageDetails = {
        version: ARTIFACT_SCHEMA_VERSION,
        artifactGroupId: stored.artifactId,
        artifacts: reps,
        ...(params.caption ? { caption: params.caption } : {}),
      };

      pi.sendMessage({
        customType: ARTIFACT_CUSTOM_TYPE,
        content: fallbackText,
        display: true,
        details,
      });

      return {
        content: [{ type: "text", text: `Displayed ${stored.mime} (${formatBytes(stored.bytes)}).` }],
        details: { artifactGroupId: stored.artifactId, url: stored.relativeUrl, mime: stored.mime },
      };
    },
  });
}

function sessionIdFromFile(sessionFile: string): string | undefined {
  if (!sessionFile) return undefined;
  const base = path.basename(sessionFile);
  // session files are <uuid>.jsonl in pi
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    details: {},
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
