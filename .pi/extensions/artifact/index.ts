/**
 * pi-remote-control artifact extension.
 *
 * Registers a `display` tool that the LLM calls to surface inline artifacts in
 * the web client's timeline:
 *
 *   - Phase A: images via display(path="...")
 *   - Phase B: HTML/D3 snippets via display(html="<svg>...</svg>") rendered
 *              in a sandboxed iframe
 *   - Phase C (next): declarative charts via display(vegaLite=..., plotly=...)
 *
 * The tool never receives raw bytes through its arguments — the LLM passes a
 * file path on disk (preferred for images/plots produced by python, etc.) or a
 * compact HTML snippet / spec object. The extension materializes the bytes
 * into the per-session artifact store and emits a `custom` message carrying a
 * MIME-tagged artifact envelope. The LLM's own tool-result text stays short
 * (one line) so we don't bloat the context window with rendered bytes.
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
import { ArtifactStore, ArtifactStoreError, type StoredArtifact } from "./artifact-store.js";
import { buildHtmlDocument, HTML_INLINE_LIMIT_BYTES, shouldSpillHtmlToFile } from "./html-template.js";

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
      "Display an inline artifact in the user's web view. Pass exactly one of " +
      "`path` (image file under cwd) or `html` (HTML/JS snippet for sandboxed iframe). " +
      "Use this immediately after saving a plot or generating an interactive snippet.",
    promptSnippet:
      "Display an inline artifact (image file or interactive HTML snippet) in the user's web view.",
    promptGuidelines: [
      "Call display(path=...) immediately after saving a plot or chart so the user sees it inline.",
      "Do not base64-encode images into display arguments. Save to a file under the project cwd and pass its path.",
      "Use display(html=...) for small interactive demos (D3 snippets, inline SVG, MathJax). The HTML runs in a sandboxed iframe with no access to the host page.",
      "Pass exactly one of `path` or `html`. Both is an error.",
      "If display fails with size_cap, downscale the image or trim the HTML before retrying.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Relative or absolute path to an image file under the project cwd. Supported types: png, jpg, jpeg, webp, gif.",
        }),
      ),
      html: Type.Optional(
        Type.String({
          description:
            "HTML/JS snippet to render in a sandboxed iframe (no access to the host page). " +
            "May include <script>, <svg>, D3, MathJax, etc. Inserted verbatim inside <body>.",
        }),
      ),
      caption: Type.Optional(
        Type.String({ description: "Optional short caption shown above the artifact." }),
      ),
      height: Type.Optional(
        Type.Number({
          description:
            "Initial iframe height in CSS pixels (HTML artifacts only). The iframe auto-resizes once the snippet loads.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "";
      const sessionId = sessionIdFromFile(sessionFile);
      if (!sessionId) {
        return errorResult("display: cannot render artifact in an ephemeral session (no session file).");
      }

      const hasPath = typeof params.path === "string" && params.path.length > 0;
      const hasHtml = typeof params.html === "string" && params.html.length > 0;
      if (hasPath === hasHtml) {
        return errorResult(
          hasPath
            ? "display: pass exactly one of `path` or `html`, not both."
            : "display: must pass exactly one of `path` or `html`.",
        );
      }

      const store = new ArtifactStore({ cwd, sessionId });

      try {
        if (hasPath) {
          return await handleImagePath(pi, store, params.path!, params.caption);
        }
        return await handleHtml(pi, store, params.html!, params.caption, params.height);
      } catch (error) {
        if (error instanceof ArtifactStoreError) {
          return errorResult(`display: ${error.message} (${error.code})`);
        }
        throw error;
      }
    },
  });
}

async function handleImagePath(
  pi: ExtensionAPI,
  store: ArtifactStore,
  sourcePath: string,
  caption: string | undefined,
) {
  const ext = path.extname(sourcePath).toLowerCase();
  const mime = SUPPORTED_IMAGE_EXTS[ext];
  if (!mime) {
    return errorResult(
      `display: unsupported image extension ${ext || "<none>"}. Supported: ${Object.keys(SUPPORTED_IMAGE_EXTS).join(", ")}.`,
    );
  }

  const stored = await store.put({ mime, sourcePath });
  const basename = path.basename(sourcePath);
  const fallbackText = caption
    ? `${caption} (${basename}, ${formatBytes(stored.bytes)})`
    : `Image: ${basename} (${formatBytes(stored.bytes)})`;

  const reps: ArtifactRepresentation[] = [
    {
      mime: stored.mime as ArtifactRepresentation["mime"],
      src: { kind: "url", url: stored.relativeUrl },
      alt: caption ?? basename,
      bytes: stored.bytes,
    } as ArtifactRepresentation,
    { mime: "text/plain", text: fallbackText },
  ];

  emitArtifactMessage(pi, stored.artifactId, reps, caption, fallbackText);

  return {
    content: [{ type: "text" as const, text: `Displayed ${stored.mime} (${formatBytes(stored.bytes)}).` }],
    details: { artifactGroupId: stored.artifactId, url: stored.relativeUrl, mime: stored.mime },
  };
}

async function handleHtml(
  pi: ExtensionAPI,
  store: ArtifactStore,
  body: string,
  caption: string | undefined,
  height: number | undefined,
) {
  // Compute id from raw snippet first so it's stable regardless of whether we
  // spill to file or embed inline (the document wrapper is identical for both).
  // We use a stable hash via the store's put() of the wrapped doc bytes — same
  // body always produces the same id.
  const placeholderId = "pending"; // will be replaced inside buildHtmlDocument once we know the id
  // First pass with a placeholder id so we can hash and decide spill vs inline.
  // Then re-build with the real id (so the in-iframe script reports under the
  // actual artifact group id, not "pending").
  const draft = buildHtmlDocument({ body, ...(caption ? { title: caption } : {}), artifactGroupId: placeholderId });
  const draftBytes = Buffer.from(draft, "utf8");
  const idSource = await import("node:crypto").then((mod) => mod.createHash("sha256").update(draftBytes).digest("hex"));
  const artifactGroupId = idSource.slice(0, 16);
  const fullHtml = buildHtmlDocument({ body, ...(caption ? { title: caption } : {}), artifactGroupId });
  const fullBytes = Buffer.from(fullHtml, "utf8");

  const fallbackText = caption
    ? `${caption} (HTML artifact, ${formatBytes(fullBytes.length)})`
    : `HTML artifact (${formatBytes(fullBytes.length)})`;

  let representation: ArtifactRepresentation;
  let stored: StoredArtifact | undefined;
  if (shouldSpillHtmlToFile(fullHtml)) {
    stored = await store.put({ mime: "text/html", bytes: fullBytes });
    representation = {
      mime: "text/html",
      src: { kind: "url", url: stored.relativeUrl },
      ...(height ? { height } : {}),
    };
  } else {
    representation = {
      mime: "text/html",
      html: fullHtml,
      ...(height ? { height } : {}),
    };
  }

  const reps: ArtifactRepresentation[] = [
    representation,
    { mime: "text/plain", text: fallbackText },
  ];

  emitArtifactMessage(pi, artifactGroupId, reps, caption, fallbackText);

  const spill = stored ? ` (spilled to ${stored.relativeUrl})` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `Displayed HTML artifact (${formatBytes(fullBytes.length)}${fullBytes.length > HTML_INLINE_LIMIT_BYTES ? ", over inline limit" : ""}).${spill}`,
      },
    ],
    details: {
      artifactGroupId,
      mime: "text/html",
      bytes: fullBytes.length,
      ...(stored ? { url: stored.relativeUrl } : {}),
    },
  };
}

function emitArtifactMessage(
  pi: ExtensionAPI,
  artifactGroupId: string,
  reps: readonly ArtifactRepresentation[],
  caption: string | undefined,
  fallbackText: string,
): void {
  const details: ArtifactMessageDetails = {
    version: ARTIFACT_SCHEMA_VERSION,
    artifactGroupId,
    artifacts: reps,
    ...(caption ? { caption } : {}),
  };
  pi.sendMessage({
    customType: ARTIFACT_CUSTOM_TYPE,
    content: fallbackText,
    display: true,
    details,
  });
}

function sessionIdFromFile(sessionFile: string): string | undefined {
  if (!sessionFile) return undefined;
  const base = path.basename(sessionFile);
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
