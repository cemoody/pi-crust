import { describe, expect, it } from "vitest";

import {
  buildHtmlDocument,
  HTML_INLINE_LIMIT_BYTES,
  shouldSpillHtmlToFile,
} from "../../.pi/extensions/artifact/html-template.js";

describe("buildHtmlDocument", () => {
  it("wraps a body in a complete HTML document with the artifact group id", () => {
    const doc = buildHtmlDocument({
      body: "<svg width='10' height='10'></svg>",
      artifactGroupId: "abc123",
      title: "Test",
    });
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain("<title>Test</title>");
    expect(doc).toContain("data-artifact-group-id=\"abc123\"");
    expect(doc).toContain("<svg width='10' height='10'></svg>");
    expect(doc).toContain("</html>");
  });

  it("escapes HTML-special characters in the title", () => {
    const doc = buildHtmlDocument({ body: "", artifactGroupId: "x", title: "<script>alert(1)</script>" });
    expect(doc).not.toContain("<title><script>");
    expect(doc).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("emits a resize-reporter script that posts to window.parent", () => {
    const doc = buildHtmlDocument({ body: "<p>x</p>", artifactGroupId: "g1" });
    expect(doc).toContain("artifact:resize");
    expect(doc).toContain("window.parent.postMessage");
    expect(doc).toContain("\"g1\"");
  });

  it("inserts the body verbatim (does not escape user-supplied HTML)", () => {
    const body = "<script>console.log('hi')</script>";
    const doc = buildHtmlDocument({ body, artifactGroupId: "g" });
    expect(doc).toContain(body);
  });
});

describe("shouldSpillHtmlToFile", () => {
  it("returns false for small documents", () => {
    expect(shouldSpillHtmlToFile("<p>hi</p>")).toBe(false);
  });

  it("returns true once the document exceeds the inline limit", () => {
    const big = "a".repeat(HTML_INLINE_LIMIT_BYTES + 1);
    expect(shouldSpillHtmlToFile(big)).toBe(true);
  });
});
