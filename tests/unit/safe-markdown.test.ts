import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { coerceMarkdownInput } from "../../src/web/utils/safe-markdown.js";

describe("coerceMarkdownInput", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns strings unchanged (the common case)", () => {
    expect(coerceMarkdownInput("hello")).toBe("hello");
    expect(coerceMarkdownInput("")).toBe("");
    expect(coerceMarkdownInput("# Heading\n\nbody")).toBe("# Heading\n\nbody");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("turns null / undefined into an empty string", () => {
    expect(coerceMarkdownInput(null)).toBe("");
    expect(coerceMarkdownInput(undefined)).toBe("");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stringifies numbers / booleans / bigints without warning (uncommon but safe)", () => {
    expect(coerceMarkdownInput(42)).toBe("42");
    expect(coerceMarkdownInput(true)).toBe("true");
    expect(coerceMarkdownInput(0)).toBe("0");
    expect(coerceMarkdownInput(false)).toBe("false");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("JSON-stringifies an object (so it at least renders) and warns once", () => {
    const obj = { type: "wrong-shape", value: "this should be a string" };
    const out = coerceMarkdownInput(obj);
    expect(out).toMatch(/wrong-shape/);
    expect(out).toMatch(/this should be a string/);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/non-string.*<Markdown>/);
  });

  it("JSON-stringifies an array (so it at least renders)", () => {
    const arr = ["a", "b", { nested: 1 }];
    const out = coerceMarkdownInput(arr);
    expect(out).toMatch(/"a"/);
    expect(out).toMatch(/"nested": 1/);
  });

  it("only warns once per shape, no matter how many times the bad input arrives", () => {
    // This module uses module-scoped state (SEEN_WARN_SHAPES). Two of the
    // tests above already produced an Object warning; a third one here
    // must NOT add another. (If a future refactor turns the warn into
    // per-call we'd flood the console at scale.)
    coerceMarkdownInput({ another: "object" });
    coerceMarkdownInput({ third: "object" });
    // We warned once in the "object" test above; nothing new here.
    expect(warnSpy).toHaveBeenCalledTimes(0);
  });

  it("never throws on unserializable input (circular, BigInts inside JSON, etc.)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => coerceMarkdownInput(cyclic)).not.toThrow();
    // We can't JSON.stringify a cycle; the fallback puts "[unserializable]".
    expect(coerceMarkdownInput(cyclic)).toBe("[unserializable]");
  });
});
