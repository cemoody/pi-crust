/**
 * TDD characterization tests for the canonical wire-content helpers being
 * consolidated into src/shared/wire-content.ts. Written before the module
 * exists; initially RED (import fails), GREEN once the module ships.
 *
 * Three near-twin implementations existed before this PR:
 *   - src/server/pi/pirpc-pi-adapter.ts (contentText, contentTextAndImages,
 *     contentTextAndThinking) — most thorough; image-aware
 *   - src/web/components/session-dashboard-helpers.ts (contentText,
 *     contentTextAndThinking, toolResultText) — JSON.stringify'd unknown
 *     blocks INTO text
 *   - src/web/state/pi-event-reducer.ts (contentText, toolResultText) —
 *     JSON.stringify'd thinking blocks INTO text (latent bug: see
 *     pi-event-reducer-thinking-from-content.test.ts)
 *
 * Canonical semantics, pinned here:
 *   - string content        -> { text: content, thinking: "", images: [] }
 *   - undefined             -> { text: "", thinking: "", images: [] }
 *   - array of blocks       -> per-field decomposition; UNKNOWN blocks
 *                              (no .text, no .thinking, type != "image")
 *                              are silently skipped rather than JSON-stringified.
 *   - anything else         -> JSON.stringify fallback in `text`.
 */
import { describe, expect, it } from "vitest";
import {
  contentText,
  contentTextAndThinking,
  toolResultText,
} from "../../src/shared/wire-content.js";

describe("contentTextAndThinking", () => {
  it("returns the string content unchanged in `text`", () => {
    expect(contentTextAndThinking("hi")).toEqual({ text: "hi", thinking: "", images: [] });
  });

  it("returns empty fields for undefined", () => {
    expect(contentTextAndThinking(undefined)).toEqual({ text: "", thinking: "", images: [] });
  });

  it("JSON.stringifies non-array, non-string, non-undefined content", () => {
    expect(contentTextAndThinking({ a: 1 })).toEqual({ text: '{"a":1}', thinking: "", images: [] });
  });

  it("separates text and thinking blocks in a content array", () => {
    const out = contentTextAndThinking([
      { type: "thinking", thinking: "weighing options" },
      { type: "text", text: "hello world" },
    ]);
    expect(out.text).toBe("hello world");
    expect(out.thinking).toBe("weighing options");
  });

  it("joins multiple text blocks with \\n and thinking blocks with \\n\\n", () => {
    const out = contentTextAndThinking([
      { type: "text", text: "alpha" },
      { type: "thinking", thinking: "step 1" },
      { type: "text", text: "beta" },
      { type: "thinking", thinking: "step 2" },
    ]);
    expect(out.text).toBe("alpha\nbeta");
    expect(out.thinking).toBe("step 1\n\nstep 2");
  });

  it("extracts image blocks with mimeType (defaulting to image/png)", () => {
    const out = contentTextAndThinking([
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "image", data: "BBBB" }, // no mimeType -> default
    ]);
    expect(out.images).toEqual([
      { data: "AAAA", mimeType: "image/jpeg" },
      { data: "BBBB", mimeType: "image/png" },
    ]);
  });

  it("silently skips unknown blocks rather than JSON-stringifying them into text", () => {
    // This is the pirpc-pi-adapter behavior; the prior session-dashboard
    // copy would have stringified the toolCall block into `text`. Pin
    // skip-semantics so we don't drift back.
    const out = contentTextAndThinking([
      { type: "text", text: "before" },
      { type: "toolCall", id: "t1", name: "bash" },
      { type: "weird-extension-block", payload: {} },
      { type: "text", text: "after" },
    ]);
    expect(out.text).toBe("before\nafter");
    expect(out.thinking).toBe("");
  });
});

describe("contentText", () => {
  it("returns just the .text field of contentTextAndThinking", () => {
    expect(contentText("hi")).toBe("hi");
    expect(contentText([{ type: "text", text: "a" }, { type: "thinking", thinking: "b" }])).toBe("a");
    expect(contentText(undefined)).toBe("");
  });
});

describe("toolResultText", () => {
  it("joins .content[].text values with \\n", () => {
    expect(toolResultText({ content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] }))
      .toBe("line1\nline2");
  });

  it("treats missing/non-text items as empty strings", () => {
    expect(toolResultText({ content: [{ type: "text", text: "x" }, { type: "image" } as { type: string }] }))
      .toBe("x\n");
  });

  it("returns empty string for non-record, non-array results", () => {
    expect(toolResultText(undefined)).toBe("");
    expect(toolResultText("plain string")).toBe("");
    expect(toolResultText({ content: "not an array" })).toBe("");
  });
});
