import { useRef, useState, type RefObject } from "react";
import { MAX_PROMPT_CHARS } from "../../shared/limits.js";
import { errorMessage, optional } from "../../shared/util.js";
import { downscaleImageIfNeeded } from "../utils/image-downscale.js";
import {
  attachmentId,
  clipboardFiles,
  clipboardImageMimeType,
  fileToBase64WithReader,
  hasClipboardImageType,
  imageAttachmentFromText,
  imageAttachmentsFromHtml,
  isBase64Blob,
  looksLikeImageData,
} from "./prompt-composer-clipboard.js";
import type { ComposerAttachment } from "./prompt-composer-clipboard.js";

export type { ComposerAttachment } from "./prompt-composer-clipboard.js";

type UpdateDraft = (next: string | ((current: string) => string), flush?: boolean) => void;

interface ComposerAttachmentOptions {
  readonly draftLength: number;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly updateDraft: UpdateDraft;
  readonly setPasteWarning: (message: string | null) => void;
}

/** Owns asynchronous attachment ingestion and guards late results after clears. */
export function useComposerAttachments({ draftLength, textareaRef, updateDraft, setPasteWarning }: ComposerAttachmentOptions) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  // Paste/file decoding is asynchronous. Keep the submission snapshot in a
  // ref as well as render state so a Send event never closes over the render
  // that preceded a just-committed attachment preview.
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  // Monotonic generation counter for attachment state. Bumped every time the
  // list is cleared so in-flight decodes cannot reappear after submission.
  const attachmentGenRef = useRef(0);

  function clearAttachments() {
    attachmentGenRef.current += 1;
    attachmentsRef.current = [];
    setAttachments([]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  async function fileToAttachment(file: File): Promise<ComposerAttachment> {
    const isImage = file.type.startsWith("image/");
    let data = await fileToBase64(file);
    let mimeType = file.type || (isImage ? "image/png" : undefined);
    if (isImage && data && mimeType) {
      const shrunk = await downscaleImageIfNeeded({ data, mimeType });
      data = shrunk.data;
      mimeType = shrunk.mimeType;
    }
    return {
      id: attachmentId(),
      name: file.name || (isImage ? "pasted image" : "attachment"),
      type: isImage ? "image" : "file",
      ...(mimeType ? { mimeType } : {}),
      ...optional({ data }),
      ...(isImage && data !== undefined ? { previewUrl: `data:${mimeType};base64,${data}` } : {}),
    };
  }

  async function maybeShrinkAttachment(attachment: ComposerAttachment): Promise<ComposerAttachment> {
    if (attachment.type !== "image" || !attachment.data || !attachment.mimeType) return attachment;
    const result = await downscaleImageIfNeeded({ data: attachment.data, mimeType: attachment.mimeType });
    if (!result.downscaled) return attachment;
    return {
      ...attachment,
      data: result.data,
      mimeType: result.mimeType,
      previewUrl: `data:${result.mimeType};base64,${result.data}`,
    };
  }

  async function addAttachments(next: readonly ComposerAttachment[], sourceGen?: number) {
    if (next.length === 0) return;
    // Callers can pin the generation captured at the start of their gesture.
    const gen = sourceGen ?? attachmentGenRef.current;
    const shrunk = await Promise.all(next.map(maybeShrinkAttachment));
    if (gen !== attachmentGenRef.current) return;
    // Update the event-time snapshot before enqueueing React state. Native
    // clipboard events can be followed immediately by a keyboard Send.
    attachmentsRef.current = [...attachmentsRef.current, ...shrunk];
    setAttachments((current) => [...current, ...shrunk]);
    setPasteWarning(null);
  }

  async function addFiles(files: FileList | readonly File[] | null) {
    if (!files) return;
    const gen = attachmentGenRef.current;
    const results = await Promise.allSettled(Array.from(files).map(fileToAttachment));
    if (gen !== attachmentGenRef.current) return;
    const next = results
      .filter((result): result is PromiseFulfilledResult<ComposerAttachment> => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    if (next.length > 0) {
      void addAttachments(next, gen);
      if (failures.length > 0) {
        setPasteWarning(`Attached ${next.length} item${next.length === 1 ? "" : "s"}, but could not read ${failures.length} other pasted item${failures.length === 1 ? "" : "s"}.`);
      } else {
        setPasteWarning(null);
      }
      return;
    }

    const firstFailure = failures[0];
    if (firstFailure) {
      const detail = errorMessage(firstFailure.reason);
      console.warn("Unable to read pasted file", firstFailure.reason);
      setPasteWarning(`Could not read that pasted file${detail ? ` (${detail})` : ""}. Try the paperclip button, or open Pi Remote Control through localhost/HTTPS if your browser is blocking clipboard image data.`);
    }
  }

  async function handleClipboardPaste(data: DataTransfer, preventDefault: () => void, insertTextWhenNotFocused: boolean) {
    const gen = attachmentGenRef.current;
    const files = clipboardFiles(data);
    if (files.length > 0) {
      preventDefault();
      await addFiles(files);
      return;
    }

    const htmlAttachments = imageAttachmentsFromHtml(data.getData("text/html"));
    if (htmlAttachments.length > 0) {
      preventDefault();
      void addAttachments(htmlAttachments, gen);
      return;
    }

    const text = data.getData("text") || data.getData("text/plain");
    const textAttachment = imageAttachmentFromText(text);
    if (textAttachment) {
      preventDefault();
      void addAttachments([textAttachment], gen);
      return;
    }

    const advertisedImageMime = clipboardImageMimeType(data);
    if (advertisedImageMime && isBase64Blob(text)) {
      preventDefault();
      const compact = text.replace(/\s/g, "");
      void addAttachments([{
        id: attachmentId(),
        name: "pasted image",
        type: "image",
        mimeType: advertisedImageMime,
        data: compact,
        previewUrl: `data:${advertisedImageMime};base64,${compact}`,
      }], gen);
      return;
    }

    if (looksLikeImageData(text) || (hasClipboardImageType(data) && isBase64Blob(text))) {
      preventDefault();
      setPasteWarning(`Clipboard looks like raw image data (${text.length.toLocaleString()} chars), but this browser did not expose it as an image file. Try copying the screenshot again, use the paperclip button, or open Pi Remote Control over HTTPS.`);
      return;
    }

    if (text.length > MAX_PROMPT_CHARS - draftLength) {
      preventDefault();
      setPasteWarning(`Paste blocked: ${text.length.toLocaleString()} chars would exceed the ${MAX_PROMPT_CHARS.toLocaleString()}-char limit.`);
      return;
    }

    if (text && insertTextWhenNotFocused) {
      preventDefault();
      updateDraft((current) => current ? `${current}${text}` : text);
      textareaRef.current?.focus({ preventScroll: true });
      return;
    }

    if (!text && hasClipboardImageType(data)) {
      setPasteWarning("The clipboard says it contains an image, but this browser did not expose the image bytes to the page. Try the paperclip button or serve Pi Remote Control over HTTPS.");
    }
  }

  return { attachments, attachmentsRef, clearAttachments, removeAttachment, addFiles, handleClipboardPaste };
}

async function fileToBase64(file: File): Promise<string> {
  if (typeof file.arrayBuffer === "function") {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    } catch {
      // Some browser/clipboard combinations expose a File object but reject arrayBuffer().
      // Try FileReader before surfacing a paste failure to the user.
    }
  }
  return fileToBase64WithReader(file);
}
