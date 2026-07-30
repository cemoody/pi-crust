import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseSessionStream } from "../../src/web/api/sse-session-stream.js";

describe("createSseSessionStream", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("uses the tab-scoped event endpoint, delivers valid payloads, and releases the source", () => {
    const source = {
      readyState: 1,
      close: vi.fn(),
      onmessage: null as ((event: { data: string; lastEventId?: string }) => void) | null,
      onopen: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    const EventSourceMock = vi.fn(function (url: string) {
      expect(url).toBe("/base/api/sessions/session%2Fid/events?tabSessionId=tab%20id");
      return source;
    });
    Object.assign(EventSourceMock, { OPEN: 1 });
    vi.stubGlobal("EventSource", EventSourceMock);
    vi.stubGlobal("window", { sessionStorage: { getItem: () => "tab id" } });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn());

    const events: unknown[] = [];
    const unsubscribe = createSseSessionStream({
      apiBase: "/base",
      sessionId: "session/id",
      onEvent: (event) => events.push(event),
    });

    source.onmessage?.({ data: JSON.stringify({ type: "message" }), lastEventId: "1" });
    source.onmessage?.({ data: "not-json" });
    expect(events).toEqual([{ type: "message" }]);

    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
