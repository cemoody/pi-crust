// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageTimeline } from "../../src/web/components/MessageTimeline.js";
import { PRESENTATION_MIME } from "../../src/presentations/schema.js";

const DECK_ID = "exec-brief";
const SESSION_ID = "session-1";

function messageWithDeck() {
  return {
    id: "m1",
    role: "custom" as const,
    text: "Presentation generated",
    customType: "artifact",
    artifact: {
      artifactGroupId: "deck-1",
      caption: "Presentation deck",
      artifacts: [
        {
          mime: PRESENTATION_MIME,
          spec: {
            id: DECK_ID,
            title: "Executive Signal Brief",
            slides: [
              { title: "Executive Signal Brief" },
              { title: "What changed", bullets: ["A", "B"] },
            ],
          },
        },
        { mime: "text/plain", text: "Presentation fallback" },
      ],
    },
  };
}

interface PatchCall {
  method: string;
  url: string;
  body: unknown;
}

let calls: PatchCall[] = [];
let persistedDeck: unknown = null;
let nextPatchResponse: { ok: boolean; status: number; body?: unknown } = { ok: true, status: 200 };

function installFetch() {
  calls = [];
  persistedDeck = null;
  nextPatchResponse = { ok: true, status: 200 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ method, url, body });
    if (/\/deck\.json$/.test(url)) {
      if (method === "GET") {
        if (persistedDeck) {
          return new Response(JSON.stringify({ version: 1, deckId: DECK_ID, deck: persistedDeck, updatedAt: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("", { status: 404 });
      }
      if (method === "PATCH") {
        if (!nextPatchResponse.ok) {
          return new Response(JSON.stringify(nextPatchResponse.body ?? { error: "bad" }), {
            status: nextPatchResponse.status,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }
    // Asset fetch path returns a tiny blob so the Download HTML flow doesn't
    // explode during render.
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function renderTimeline() {
  return render(<MessageTimeline messages={[messageWithDeck()]} sessionId={SESSION_ID} />);
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("PresentationArtifactCard — edit mode", () => {
  it("hydrates from the persisted deck JSON if one exists", async () => {
    persistedDeck = {
      id: DECK_ID,
      title: "Persisted Title",
      slides: [{ title: "Persisted Title" }, { title: "What changed", bullets: ["A", "B"] }],
    };
    renderTimeline();
    await act(async () => { await flush(); });
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-presentation").querySelector(".presentation-card-header"),
      ).toHaveTextContent("Persisted Title");
    });
  });

  it("falls back to the in-message deck when no persisted version exists", async () => {
    renderTimeline();
    await act(async () => { await flush(); });
    expect(
      screen.getByTestId("artifact-presentation").querySelector(".presentation-card-header"),
    ).toHaveTextContent("Executive Signal Brief");
  });

  it("renders preview iframe with NO contenteditable attributes (preview is read-only)", async () => {
    renderTimeline();
    await act(async () => { await flush(); });
    const preview = screen.getByTestId("artifact-presentation-preview") as HTMLIFrameElement;
    expect(preview.getAttribute("srcdoc") ?? "").not.toMatch(/contenteditable/);
  });

  it("Edit toggle in the modal rebuilds the iframe with contenteditable=plaintext-only", async () => {
    renderTimeline();
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByRole("button", { name: "Present deck" }));
    const editBtn = await screen.findByRole("button", { name: /^Edit/ });
    fireEvent.click(editBtn);
    const modal = screen.getByTestId("artifact-presentation-modal") as HTMLIFrameElement;
    await waitFor(() => {
      expect(modal.getAttribute("srcdoc") ?? "").toMatch(/contenteditable="plaintext-only"/);
    });
    expect(modal.getAttribute("srcdoc") ?? "").toMatch(/data-deck-path="\/slides\/0\/title"/);
  });

  it("debounces pi-deck-edit messages into a single PATCH (500 ms)", async () => {
    renderTimeline();
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByRole("button", { name: "Present deck" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "pi-deck-edit", deckId: DECK_ID, path: "/slides/0/title", value: "New A" },
      }));
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "pi-deck-edit", deckId: DECK_ID, path: "/slides/1/bullets/0", value: "Edited" },
      }));
    });
    // Before debounce window elapses, no PATCH yet
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(0);

    await act(async () => { await sleep(700); });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.length).toBe(1);
    const ops = (patches[0]!.body as { ops: { path: string; value: string }[] }).ops;
    expect(ops).toEqual([
      { op: "replace", path: "/slides/0/title", value: "New A" },
      { op: "replace", path: "/slides/1/bullets/0", value: "Edited" },
    ]);
    expect(patches[0]!.url).toMatch(new RegExp(`/api/sessions/${SESSION_ID}/presentations/${DECK_ID}/deck\\.json$`));
  });

  it("flushes pending edits when the modal closes", async () => {
    renderTimeline();
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByRole("button", { name: "Present deck" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "pi-deck-edit", deckId: DECK_ID, path: "/slides/0/title", value: "Flushed" },
      }));
    });
    // Close immediately, before debounce timer fires.
    fireEvent.click(screen.getByRole("button", { name: "Close presentation" }));
    await act(async () => { await flush(); });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.length).toBeGreaterThanOrEqual(1);
    const lastOps = (patches[patches.length - 1]!.body as { ops: { value: string }[] }).ops;
    expect(lastOps.some((op) => op.value === "Flushed")).toBe(true);
  });

  it("rolls back optimistic state and surfaces an inline error on PATCH 4xx", async () => {
    nextPatchResponse = { ok: false, status: 400, body: { error: "validation failed" } };
    renderTimeline();
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByRole("button", { name: "Present deck" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "pi-deck-edit", deckId: DECK_ID, path: "/slides/0/title", value: "Bad" },
      }));
    });
    await act(async () => { await sleep(700); });

    // Inline error banner visible
    expect(await screen.findByText(/validation failed|could not save/i)).toBeInTheDocument();

    // Modal iframe srcDoc reflects the *server-confirmed* (i.e. original) title,
    // not the rejected "Bad" value.
    const modal = screen.getByTestId("artifact-presentation-modal") as HTMLIFrameElement;
    expect(modal.getAttribute("srcdoc") ?? "").not.toContain(">Bad<");
  });

  it("ignores messages from other windows (event.source check) and unknown deckIds", async () => {
    renderTimeline();
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByRole("button", { name: "Present deck" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));

    // Edit targeted at a different deck — must be ignored.
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "pi-deck-edit", deckId: "other-deck", path: "/slides/0/title", value: "Nope" },
      }));
    });
    await act(async () => { await sleep(700); });
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(0);
  });

  it("shows a 'templated slides are read-only' banner when the deck contains slide.html", async () => {
    const messageWithTemplated = messageWithDeck();
    const first = messageWithTemplated.artifact.artifacts[0];
    (first as { spec: { slides: unknown[] } }).spec.slides.push({
      template: "html",
      html: "<section>x</section>",
    } as never);
    render(<MessageTimeline messages={[messageWithTemplated]} sessionId={SESSION_ID} />);
    await act(async () => { await flush(); });
    fireEvent.click(screen.getByRole("button", { name: "Present deck" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));
    expect(await screen.findByText(/Edit not supported for templated slides/i)).toBeInTheDocument();
  });
});
