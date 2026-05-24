// @vitest-environment jsdom
/**
 * TDD characterization tests for the clipboard-paste-as-image helpers being
 * lifted out of PromptComposer.tsx into prompt-composer-clipboard.ts.
 *
 * Each test pins one concrete branch of one helper so the move can't
 * silently regress. Written before the extraction; initially RED (module
 * import fails), GREEN after the new module is in place.
 */
import { describe, expect, it } from "vitest";
import {
  imageAttachmentFromDataUrl,
  imageAttachmentFromRawBase64,
  imageAttachmentFromText,
  imageAttachmentsFromHtml,
  isBase64Blob,
  looksLikeImageData,
  rawBase64ImageMimeType,
} from "../../src/web/components/prompt-composer-clipboard.js";

// ---------- imageAttachmentFromDataUrl ----------

describe("imageAttachmentFromDataUrl", () => {
  it("parses PNG/JPEG/GIF/WEBP data URLs", () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const url = `data:image/png;base64,${data}`;
    const att = imageAttachmentFromDataUrl(url, "x")!;
    expect(att.type).toBe("image");
    expect(att.mimeType).toBe("image/png");
    expect(att.data).toBe(data);
    expect(att.previewUrl).toBe(url);
  });

  it("lowercases the MIME type", () => {
    const att = imageAttachmentFromDataUrl("data:Image/JPEG;base64,aGVsbG8=", "y")!;
    expect(att.mimeType).toBe("image/jpeg");
  });

  it("returns null for non-image data URLs and bare strings", () => {
    expect(imageAttachmentFromDataUrl("data:text/plain;base64,aGVsbG8=", "x")).toBeNull();
    expect(imageAttachmentFromDataUrl("not a url at all", "x")).toBeNull();
    expect(imageAttachmentFromDataUrl("", "x")).toBeNull();
  });
});

// ---------- rawBase64ImageMimeType ----------

describe("rawBase64ImageMimeType", () => {
  it("recognizes PNG/JPEG/GIF/WEBP magic prefixes (≥64 chars)", () => {
    const pad = "A".repeat(60);
    expect(rawBase64ImageMimeType(`iVBORw0KGgo${pad}`)).toBe("image/png");
    expect(rawBase64ImageMimeType(`/9j/${pad}`)).toBe("image/jpeg");
    expect(rawBase64ImageMimeType(`R0lGOD${pad}`)).toBe("image/gif");
    expect(rawBase64ImageMimeType(`UklGR${pad}`)).toBe("image/webp");
  });

  it("returns null for too-short input or unknown magic", () => {
    expect(rawBase64ImageMimeType("iVBORw0KGgo")).toBeNull(); // < 64
    expect(rawBase64ImageMimeType("Z".repeat(128))).toBeNull();
  });
});

// ---------- imageAttachmentFromRawBase64 ----------

describe("imageAttachmentFromRawBase64", () => {
  it("returns an attachment when the base64 starts with a known image magic", () => {
    const data = `iVBORw0KGgo${"A".repeat(80)}`;
    const att = imageAttachmentFromRawBase64(data, "raw.png")!;
    expect(att.mimeType).toBe("image/png");
    expect(att.data).toBe(data);
    expect(att.previewUrl).toBe(`data:image/png;base64,${data}`);
  });

  it("strips internal whitespace from the data before checking", () => {
    const data = `iVBORw0KGgo${"A".repeat(80)}`;
    const att = imageAttachmentFromRawBase64(`  ${data}\n`, "raw.png")!;
    expect(att.data).toBe(data);
  });

  it("returns null when no magic prefix matches", () => {
    expect(imageAttachmentFromRawBase64("Z".repeat(128), "x")).toBeNull();
  });
});

// ---------- imageAttachmentFromText ----------

describe("imageAttachmentFromText", () => {
  it("prefers the data-URL path", () => {
    const att = imageAttachmentFromText("data:image/png;base64,aGVsbG8=")!;
    expect(att.mimeType).toBe("image/png");
  });

  it("falls back to the raw-base64 path", () => {
    const data = `iVBORw0KGgo${"A".repeat(80)}`;
    const att = imageAttachmentFromText(data)!;
    expect(att.mimeType).toBe("image/png");
  });

  it("returns null for empty/whitespace text", () => {
    expect(imageAttachmentFromText("")).toBeNull();
    expect(imageAttachmentFromText("   \t\n  ")).toBeNull();
  });
});

// ---------- imageAttachmentsFromHtml ----------

describe("imageAttachmentsFromHtml", () => {
  it("extracts <img src=\"data:image/...;base64,...\"> URLs and de-duplicates them", () => {
    const data = "aGVsbG8=";
    const url = `data:image/png;base64,${data}`;
    const html = `<p>hi</p><img src="${url}"/><img src='${url}' />`;
    const attachments = imageAttachmentsFromHtml(html);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.mimeType).toBe("image/png");
  });

  it("returns [] for HTML without image data URLs", () => {
    expect(imageAttachmentsFromHtml("<p>no images</p>")).toEqual([]);
    expect(imageAttachmentsFromHtml("")).toEqual([]);
  });
});

// ---------- isBase64Blob ----------

describe("isBase64Blob", () => {
  it("accepts a ≥512-char base64-alphabet string with optional whitespace and padding", () => {
    expect(isBase64Blob("A".repeat(512))).toBe(true);
    expect(isBase64Blob("A".repeat(510) + "==")).toBe(true);
    expect(isBase64Blob(`A${" ".repeat(2)}${"A".repeat(520)}`)).toBe(true);
  });

  it("rejects under-length, empty, or non-base64 input", () => {
    expect(isBase64Blob("")).toBe(false);
    expect(isBase64Blob("A".repeat(100))).toBe(false);
    expect(isBase64Blob(`${"A".repeat(512)}!`)).toBe(false);
  });
});

// ---------- looksLikeImageData ----------

describe("looksLikeImageData", () => {
  it("recognizes a PNG-magic base64 prefix early in a large string", () => {
    expect(looksLikeImageData("iVBORw0KGgo" + "A".repeat(2000))).toBe(true);
  });

  it("recognizes a JPEG-magic base64 prefix", () => {
    expect(looksLikeImageData("/9j/" + "A".repeat(2000))).toBe(true);
  });

  it("recognizes a data:image/...;base64 substring within the head window", () => {
    expect(looksLikeImageData("preamble data:image/png;base64,abc..." + "x".repeat(1100))).toBe(true);
  });

  it("returns false for short text or text without any image signal", () => {
    expect(looksLikeImageData("short")).toBe(false);
    expect(looksLikeImageData("x".repeat(2000))).toBe(false);
  });
});
