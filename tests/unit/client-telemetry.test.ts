import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { derivePageLoadContext, recordClientEvent } from "../../src/web/utils/client-telemetry.js";

function makeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
  };
}

function makePerf(type: PerformanceNavigationTiming["type"] | undefined) {
  return {
    getEntriesByType: () => (type === undefined ? [] : [{ type } as PerformanceNavigationTiming]),
  };
}

describe("derivePageLoadContext", () => {
  it("classifies navigation types", () => {
    for (const t of ["navigate", "reload", "back_forward", "prerender"] as const) {
      const ctx = derivePageLoadContext({
        performance: makePerf(t),
        document: { referrer: "", visibilityState: "visible" },
        storage: makeStorage(),
        url: "http://x/",
        newUUID: () => "uuid-1",
      });
      expect(ctx.navigationType).toBe(t);
    }
  });

  it("falls back to 'unknown' when navigation timing is missing", () => {
    const ctx = derivePageLoadContext({
      performance: makePerf(undefined),
      document: { referrer: "", visibilityState: "visible" },
      storage: makeStorage(),
      url: "http://x/",
      newUUID: () => "uuid-1",
    });
    expect(ctx.navigationType).toBe("unknown");
  });

  it("increments a bootCount in storage on every call", () => {
    const storage = makeStorage();
    const dep = {
      performance: makePerf("navigate"),
      document: { referrer: "", visibilityState: "visible" as const },
      storage,
      url: "http://x/",
      newUUID: () => "uuid-1",
    };
    expect(derivePageLoadContext(dep).bootCount).toBe(1);
    expect(derivePageLoadContext(dep).bootCount).toBe(2);
    expect(derivePageLoadContext(dep).bootCount).toBe(3);
  });

  it("generates and persists a stable tabSessionId across boots", () => {
    const storage = makeStorage();
    let counter = 0;
    const newUUID = () => `uuid-${++counter}`;
    const a = derivePageLoadContext({
      performance: makePerf("navigate"),
      document: { referrer: "", visibilityState: "visible" },
      storage, url: "http://x/", newUUID,
    });
    const b = derivePageLoadContext({
      performance: makePerf("reload"),
      document: { referrer: "", visibilityState: "visible" },
      storage, url: "http://x/", newUUID,
    });
    expect(a.tabSessionId).toBe("uuid-1");
    expect(b.tabSessionId).toBe("uuid-1"); // reused across boots
  });
});

describe("recordClientEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses fetch with keepalive by default", () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 })) as unknown as Mock<(input: string, init?: RequestInit) => Promise<Response>>;
    vi.stubGlobal("fetch", fetchSpy);
    recordClientEvent({ kind: "boot", bootCount: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect(call[0]).toBe("/api/client-event");
    const init = call[1] ?? {};
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ kind: "boot", bootCount: 1 });
    expect(typeof body.clientTs).toBe("number");
  });

  it("uses navigator.sendBeacon when 'leaving' is set", () => {
    const sendBeacon = vi.fn(() => true) as unknown as Mock<(url: string, body?: BodyInit) => boolean>;
    vi.stubGlobal("navigator", { sendBeacon });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    recordClientEvent({ kind: "pagehide" }, { leaving: true });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const call = sendBeacon.mock.calls[0] as [string, BodyInit];
    expect(call[0]).toBe("/api/client-event");
    expect(call[1]).toBeInstanceOf(Blob);
  });

  it("never throws even when both transports are missing", () => {
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("navigator", undefined);
    expect(() => recordClientEvent({ kind: "boot" })).not.toThrow();
    expect(() => recordClientEvent({ kind: "pagehide" }, { leaving: true })).not.toThrow();
  });
});
