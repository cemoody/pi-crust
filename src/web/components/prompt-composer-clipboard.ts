/**
 * Clipboard-paste-as-image helpers for PromptComposer.
 *
 * Extracted from PromptComposer.tsx (which kept the component and its
 * React state). All exports are pure: no React, no DOM mutations beyond
 * DOMParser, no I/O. The composer's paste pipeline funnels everything
 * a user might paste — File objects, dragged images, HTML fragments with
 * inline data URLs, raw base64 blobs (iOS, BeyondCompare, etc.) —
 * through these helpers and into a ComposerAttachment.
 *
 * Behavior pinned by tests/unit/prompt-composer-clipboard.test.ts.
 */

export interface ComposerAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: "image" | "file";
  readonly mimeType?: string;
  readonly data?: string;
  readonly previewUrl?: string;
}

export function fileToBase64WithReader(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("FileReader returned non-text data"));
        return;
      }
      const comma = reader.result.indexOf(",");
      resolve(comma === -1 ? reader.result : reader.result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function isEditablePasteTarget(element: HTMLElement): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return true;
  return element.isContentEditable;
}

export function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files).filter((file): file is File => file instanceof File);
  if (files.length > 0) return files;
  return Array.from(data.items)
    .filter((item) => item.kind === "file" || item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function hasClipboardImageType(data: DataTransfer): boolean {
  return Array.from(data.types).some((type) => type === "Files" || type.startsWith("image/"))
    || Array.from(data.items).some((item) => item.type.startsWith("image/"));
}

/**
 * Best-effort: pull a concrete `image/<subtype>` MIME out of the clipboard
 * metadata so we can attach raw base64 that arrived without a recognised
 * magic prefix (HEIC, Apple CGImage exports, etc. on iOS). Returns null if
 * the clipboard only advertised the generic "Files" sentinel.
 */
export function clipboardImageMimeType(data: DataTransfer): string | null {
  const types = data.types ? Array.from(data.types) : [];
  for (const type of types) {
    if (typeof type === "string" && type.toLowerCase().startsWith("image/")) return type.toLowerCase();
  }
  const items = data.items ? Array.from(data.items) : [];
  for (const item of items) {
    if (item && item.type && item.type.toLowerCase().startsWith("image/")) return item.type.toLowerCase();
  }
  return null;
}

/**
 * Returns true if `text` is plausibly a single base64 blob (>=512 bytes of
 * base64 alphabet, optional whitespace, optional trailing padding). Used as
 * a secondary signal alongside hasClipboardImageType / an advertised image
 * MIME — we don't gate on magic prefixes here because iOS clipboards
 * routinely produce base64 whose head is not in our short allow-list.
 */
export function isBase64Blob(text: string): boolean {
  if (!text) return false;
  const compact = text.replace(/\s/g, "");
  if (compact.length < 512) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(compact);
}

export function imageAttachmentsFromHtml(html: string): ComposerAttachment[] {
  if (!html) return [];
  const urls = new Set<string>();
  if (typeof DOMParser === "function") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
      const src = img.getAttribute("src");
      if (src) urls.add(src);
    }
  }
  for (const match of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) urls.add(match[1] ?? "");
  return Array.from(urls)
    .map((url, index) => imageAttachmentFromDataUrl(url, `pasted-image-${index + 1}`))
    .filter((attachment): attachment is ComposerAttachment => attachment !== null);
}

export function imageAttachmentFromText(text: string): ComposerAttachment | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return imageAttachmentFromDataUrl(trimmed, "pasted image") ?? imageAttachmentFromRawBase64(trimmed, "pasted image");
}

export function imageAttachmentFromDataUrl(value: string, name: string): ComposerAttachment | null {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
  if (!match) return null;
  const mimeType = match[1]?.toLowerCase();
  const data = match[2]?.replace(/\s/g, "") ?? "";
  if (!mimeType) return null;
  if (!data) return null;
  return {
    id: attachmentId(),
    name,
    type: "image",
    mimeType,
    data,
    previewUrl: `data:${mimeType};base64,${data}`,
  };
}

export function imageAttachmentFromRawBase64(value: string, name: string): ComposerAttachment | null {
  const data = value.replace(/\s/g, "");
  const mimeType = rawBase64ImageMimeType(data);
  if (!mimeType) return null;
  return {
    id: attachmentId(),
    name,
    type: "image",
    mimeType,
    data,
    previewUrl: `data:${mimeType};base64,${data}`,
  };
}

export function attachmentId(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const random = typeof crypto?.getRandomValues === "function"
    ? Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) => value.toString(36)).join("")
    : Math.random().toString(36).slice(2);
  return `attachment-${Date.now().toString(36)}-${random}`;
}

export function rawBase64ImageMimeType(data: string): string | null {
  if (data.length < 64) return null;
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR")) return "image/webp";
  return null;
}

export function looksLikeImageData(text: string): boolean {
  if (text.length < 1024) return false;
  const head = text.slice(0, 512);
  if (/data:image\/(png|jpe?g|gif|webp);base64,/i.test(head)) return true;
  if (/iVBORw0KGgo/.test(head)) return true; // PNG magic in base64
  if (/\/9j\/[A-Za-z0-9+/]{20,}/.test(head)) return true; // JPEG magic in base64
  if (/"type"\s*:\s*"image"/i.test(head) && /"data"\s*:\s*"[A-Za-z0-9+/=]{100,}/.test(text)) return true;
  return false;
}
