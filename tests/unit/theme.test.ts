// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DARK_THEME_COLOR,
  LIGHT_THEME_COLOR,
  THEME_STORAGE_KEY,
  applyTheme,
  getActiveTheme,
  getPreferredTheme,
  initTheme,
  setStoredTheme,
} from "../../src/web/utils/theme.js";

// jsdom does not implement matchMedia; theme.ts uses it to detect the OS
// prefers-color-scheme. Install a controllable stub (same shape used by
// message-text-coerce.test.tsx).
function installMatchMedia(prefersDark: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function resetTheme(): void {
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  // Remove any theme-color metas previous tests appended so each test
  // starts from a clean DOM (querySelector returns at most one).
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
}

beforeEach(() => {
  resetTheme();
  installMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTheme();
});

describe("THEME_STORAGE_KEY", () => {
  // Pinned so an external reader (service worker, future extension) that
  // migrates the key doesn't silently lose the user's choice.
  it("is the documented localStorage key", () => {
    expect(THEME_STORAGE_KEY).toBe("pi-crust-theme");
  });
});

describe("getPreferredTheme", () => {
  it("returns the stored preference when it is a valid theme", () => {
    installMatchMedia(true); // OS says dark; stored pref must win.
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(getPreferredTheme()).toBe("light");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(getPreferredTheme()).toBe("dark");
  });

  it("falls back to the OS preference when nothing is stored", () => {
    installMatchMedia(true);
    expect(getPreferredTheme()).toBe("dark");
    installMatchMedia(false);
    expect(getPreferredTheme()).toBe("light");
  });

  it("ignores garbage in localStorage and falls back to OS", () => {
    installMatchMedia(true);
    localStorage.setItem(THEME_STORAGE_KEY, "banana");
    expect(getPreferredTheme()).toBe("dark");
  });

  it("defaults to light when no pref is stored and OS prefers light", () => {
    installMatchMedia(false);
    expect(getPreferredTheme()).toBe("light");
  });
});

describe("getActiveTheme", () => {
  it("reads the data-theme attribute off the document element", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    expect(getActiveTheme()).toBe("dark");
    document.documentElement.setAttribute("data-theme", "light");
    expect(getActiveTheme()).toBe("light");
  });

  it("defaults to light when the attribute is absent", () => {
    expect(getActiveTheme()).toBe("light");
  });
});

describe("applyTheme", () => {
  it("writes data-theme onto the document element", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("updates the theme-color meta so the browser chrome matches", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#000000";
    document.head.appendChild(meta);

    applyTheme("dark");
    expect(meta.content).toBe(DARK_THEME_COLOR);
    applyTheme("light");
    expect(meta.content).toBe(LIGHT_THEME_COLOR);
  });

  it("does not throw when the theme-color meta is absent", () => {
    expect(() => applyTheme("dark")).not.toThrow();
  });
});

describe("setStoredTheme", () => {
  it("persists the choice under THEME_STORAGE_KEY", () => {
    setStoredTheme("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    setStoredTheme("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("swallows localStorage failures so the toggle never crashes", () => {
    // Private mode / disabled storage can throw on write; the in-memory
    // data-theme attribute still applies for the session.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => setStoredTheme("dark")).not.toThrow();
  });
});

describe("initTheme", () => {
  it("applies the stored preference to the document", () => {
    installMatchMedia(true); // OS says dark; stored pref wins.
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    initTheme();
    expect(getActiveTheme()).toBe("light");
  });

  it("applies the OS preference when nothing is stored", () => {
    installMatchMedia(true);
    initTheme();
    expect(getActiveTheme()).toBe("dark");
  });

  it("syncs the theme-color meta alongside the document attribute", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
    installMatchMedia(false);
    initTheme();
    expect(getActiveTheme()).toBe("light");
    expect(meta.content).toBe(LIGHT_THEME_COLOR);
  });
});
