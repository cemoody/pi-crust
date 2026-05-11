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

// Hard caps for declarative chart specs. Specs over the inline limit are
// spilled to the artifact store; specs over the absolute max are rejected.
const SPEC_INLINE_LIMIT_BYTES = 32 * 1024;
const SPEC_MAX_BYTES = 256 * 1024;

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
      "`path` (image file under cwd), `html` (snippet for sandboxed iframe), " +
      "`vegaLite` (Vega-Lite v5 spec object), or `plotly` (Plotly figure object). " +
      "Use this immediately after generating a chart, plot, or snippet.",
    promptSnippet:
      "Display an inline artifact (image file or interactive HTML snippet) in the user's web view.",
    promptGuidelines: [
      "Call display(path=...) immediately after saving a plot or chart so the user sees it inline.",
      "Do not base64-encode images into display arguments. Save to a file under the project cwd and pass its path.",
      "Prefer display(vegaLite=...) for static charts (bar, line, scatter, heatmap). Vega-Lite specs are tiny, re-theme automatically, and degrade to text/plain for non-web clients.",
      "Use display(plotly=...) when interactive 3D, animation, or specialized Plotly traces are needed.",
      "Use display(html=...) for ad-hoc D3 snippets or other arbitrary HTML/JS. The HTML runs in a sandboxed iframe with no access to the host page.",
      "Pass exactly one of `path`, `html`, `vegaLite`, or `plotly`. More than one is an error.",
      "If display fails with size_cap, downscale the image or trim the spec before retrying.",
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
      vegaLite: Type.Optional(
        Type.Any({
          description:
            "Vega-Lite v5 spec object (https://vega.github.io/vega-lite/). Will be re-themed automatically. Max 256KB.",
        }),
      ),
      plotly: Type.Optional(
        Type.Any({
          description:
            "Plotly figure object: { data: [...], layout?: {...}, config?: {...} }. Max 256KB.",
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

      const modes = [
        params.path && typeof params.path === "string" && params.path.length > 0 ? "path" : undefined,
        params.html && typeof params.html === "string" && params.html.length > 0 ? "html" : undefined,
        params.vegaLite && typeof params.vegaLite === "object" ? "vegaLite" : undefined,
        params.plotly && typeof params.plotly === "object" ? "plotly" : undefined,
      ].filter((m): m is string => m !== undefined);

      if (modes.length === 0) {
        return errorResult("display: pass one of `path`, `html`, `vegaLite`, or `plotly`.");
      }
      if (modes.length > 1) {
        return errorResult(`display: pass exactly one of path/html/vegaLite/plotly; got: ${modes.join(", ")}.`);
      }

      const store = new ArtifactStore({ cwd, sessionId });

      try {
        const mode = modes[0];
        if (mode === "path") return await handleImagePath(pi, store, params.path!, params.caption);
        if (mode === "html") return await handleHtml(pi, store, params.html!, params.caption, params.height);
        if (mode === "vegaLite") {
          return await handleDeclarativeSpec(
            pi,
            store,
            params.vegaLite,
            "application/vnd.vega-lite.v5+json",
            "vl.json",
            "Vega-Lite",
            params.caption,
          );
        }
        if (mode === "plotly") {
          return await handleDeclarativeSpec(
            pi,
            store,
            params.plotly,
            "application/vnd.plotly.v1+json",
            "plotly.json",
            "Plotly",
            params.caption,
          );
        }
        return errorResult(`display: unknown mode "${mode}".`);
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

type DeclarativeMime = "application/vnd.vega-lite.v5+json" | "application/vnd.plotly.v1+json";

async function handleDeclarativeSpec(
  pi: ExtensionAPI,
  store: ArtifactStore,
  spec: unknown,
  mime: DeclarativeMime,
  _ext: string,
  label: string,
  caption: string | undefined,
) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return errorResult(`display: ${label} spec must be a plain object.`);
  }
  let json: string;
  try {
    json = JSON.stringify(spec);
  } catch (error) {
    return errorResult(
      `display: ${label} spec is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > SPEC_MAX_BYTES) {
    return errorResult(
      `display: ${label} spec is ${formatBytes(bytes)}; the maximum is ${formatBytes(SPEC_MAX_BYTES)}. Trim before retrying.`,
    );
  }

  let representation: ArtifactRepresentation;
  let artifactGroupId: string;
  let stored: StoredArtifact | undefined;
  if (bytes > SPEC_INLINE_LIMIT_BYTES) {
    stored = await store.put({ mime, bytes: Buffer.from(json, "utf8") });
    artifactGroupId = stored.artifactId;
    // For spilled specs, the web client fetches the JSON from the artifact URL
    // and rehydrates. We still embed the URL inside the spec/figure key so the
    // wire envelope is self-describing without changing the representation shape.
    representation =
      mime === "application/vnd.vega-lite.v5+json"
        ? { mime, spec: { $ref: stored.relativeUrl } }
        : { mime, figure: { $ref: stored.relativeUrl } };
  } else {
    artifactGroupId = (await import("node:crypto"))
      .createHash("sha256")
      .update(json)
      .digest("hex")
      .slice(0, 16);
    representation =
      mime === "application/vnd.vega-lite.v5+json"
        ? { mime, spec }
        : { mime, figure: spec };
  }

  const fallbackText = caption
    ? `${caption} (${label} spec, ${formatBytes(bytes)})`
    : `${label} chart (${formatBytes(bytes)})`;

  const reps: ArtifactRepresentation[] = [
    representation,
    { mime: "text/plain", text: fallbackText },
  ];
  emitArtifactMessage(pi, artifactGroupId, reps, caption, fallbackText);

  const spill = stored ? ` (spilled to ${stored.relativeUrl})` : "";
  return {
    content: [{ type: "text" as const, text: `Displayed ${label} chart (${formatBytes(bytes)}).${spill}` }],
    details: {
      artifactGroupId,
      mime,
      bytes,
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
