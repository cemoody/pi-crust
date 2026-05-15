/**
 * Tests for hmr-tame.ts. We exercise the pure `shouldSuppressReload`
 * function directly AND the `installHmrTame` wiring with a fake document
 * + fake hot, so that we never depend on Vite injecting a real
 * `import.meta.hot` at test time.
 */
import { describe, expect, it, vi } from "vitest";
import { shouldSuppressReload, installHmrTame, SUPPRESS_WINDOW_AFTER_RESUME_MS } from "../../src/web/utils/hmr-tame.js";

describe("shouldSuppressReload", () => {
  it("suppresses when the tab is currently hidden", () => {
    expect(shouldSuppressReload({ visibilityState: () => "hidden", now: () => 1_000 }, 0)).toBe(true);
  });

  it("suppresses within the resume window even while visible", () => {
    expect(shouldSuppressReload(
      { visibilityState: () => "visible", now: () => 1_000 },
      1_000 - (SUPPRESS_WINDOW_AFTER_RESUME_MS - 1),
    )).toBe(true);
  });

  it("does NOT suppress once the resume window has elapsed and the tab is visible", () => {
    expect(shouldSuppressReload(
      { visibilityState: () => "visible", now: () => 1_000 },
      1_000 - SUPPRESS_WINDOW_AFTER_RESUME_MS - 1,
    )).toBe(false);
  });

  it("suppresses when visibility is hidden even far past the resume window (defensive)", () => {
    expect(shouldSuppressReload(
      { visibilityState: () => "hidden", now: () => 1_000_000 },
      0,
    )).toBe(true);
  });
});

describe("installHmrTame", () => {
  type HotEvent = { preventDefault?: () => void };
  function makeFakeHot(): { on: (name: string, cb: (e: HotEvent) => void) => void; trigger: (e: HotEvent) => void } {
    let handler: ((e: HotEvent) => void) | null = null;
    return {
      on: (name, cb) => { if (name === "vite:beforeFullReload") handler = cb; },
      trigger: (e) => { if (handler) handler(e); else throw new Error("no handler"); },
    };
  }
  function makeFakeDocument(state: "visible" | "hidden"): { visibilityState: string; listeners: Array<() => void>; addEventListener: (n: string, cb: () => void) => void; setVisibility: (s: "visible" | "hidden") => void } {
    const doc = {
      visibilityState: state as string,
      listeners: [] as Array<() => void>,
      addEventListener(name: string, cb: () => void) { if (name === "visibilitychange") this.listeners.push(cb); },
      setVisibility(s: "visible" | "hidden") {
        this.visibilityState = s;
        for (const fn of this.listeners) fn();
      },
    };
    return doc;
  }

  it("cancels the reload when triggered while hidden", () => {
    const hot = makeFakeHot();
    const doc = makeFakeDocument("hidden");
    installHmrTame({ document: doc, hot, now: () => 1_000 });
    const preventDefault = vi.fn();
    hot.trigger({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("cancels the reload right after resuming from hidden", () => {
    const hot = makeFakeHot();
    const doc = makeFakeDocument("hidden");
    let t = 1_000;
    installHmrTame({ document: doc, hot, now: () => t });
    t = 5_000;
    doc.setVisibility("visible"); // lastVisibleAt becomes 5_000
    t = 6_000;                    // 1s after resume — still inside the window
    const preventDefault = vi.fn();
    hot.trigger({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("lets the reload through once visible-stable for >5s", () => {
    const hot = makeFakeHot();
    const doc = makeFakeDocument("visible");
    let t = 1_000;
    installHmrTame({ document: doc, hot, now: () => t }); // lastVisibleAt = 1_000
    t = 1_000 + SUPPRESS_WINDOW_AFTER_RESUME_MS + 100;     // past the window
    const preventDefault = vi.fn();
    hot.trigger({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("is a no-op if hot is undefined (e.g. production build)", () => {
    const doc = makeFakeDocument("visible");
    expect(() => installHmrTame({ document: doc, hot: undefined, now: () => 0 })).not.toThrow();
  });

  it("does not throw if the reload event lacks preventDefault (older Vite)", () => {
    const hot = makeFakeHot();
    const doc = makeFakeDocument("hidden");
    installHmrTame({ document: doc, hot, now: () => 0 });
    expect(() => hot.trigger({})).not.toThrow();
  });
});
