// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
  }
});
import { SessionDashboard } from "../../src/web/components/SessionDashboard.js";
import type { ExtensionUiResponse } from "../../src/shared/protocol.js";
import type { SessionCardData, SessionDashboardApi, NewSessionInput } from "../../src/web/api/session-api.js";

function renderDashboardCapturingPrompts() {
  const promptCalls: Array<{ readonly sessionId: string; readonly text: string }> = [];
  const renameCalls: Array<{ readonly sessionId: string; readonly name: string }> = [];
  const baseApi = makeApi();
  const api: SessionDashboardApi = {
    ...baseApi,
    async prompt(sessionId, text) {
      promptCalls.push({ sessionId, text });
      return [
        { id: `u-${promptCalls.length}`, role: "user", text },
        { id: `a-${promptCalls.length}`, role: "assistant", text: `Mock response to: ${text}` },
      ];
    },
    async renameSession(sessionId, name) {
      renameCalls.push({ sessionId, name });
      return baseApi.renameSession(sessionId, name);
    },
  };
  render(<SessionDashboard api={api} />);
  return { promptCalls, renameCalls };
}

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function makeApi(initial: SessionCardData[] = []): SessionDashboardApi {
  let sessions = [...initial];
  return {
    async listSessions() {
      return sessions;
    },
    async createSession(input: NewSessionInput) {
      const created: SessionCardData = {
        id: `session-${sessions.length + 1}`,
        cwd: input.cwd,
        ...(input.sessionName === undefined ? {} : { sessionName: input.sessionName }),
        status: "idle",
        model: "mock/model",
        tokenSummary: "0 tokens",
        lastActivity: Date.now(),
      };
      sessions = [created, ...sessions];
      return created;
    },
    async renameSession(sessionId: string, name: string) {
      sessions = sessions.map((session) => session.id === sessionId ? { ...session, sessionName: name } : session);
      const updated = sessions.find((session) => session.id === sessionId);
      if (!updated) throw new Error("missing");
      return updated;
    },
    async deleteSession(sessionId: string) {
      sessions = sessions.filter((session) => session.id !== sessionId);
    },
    async getSession(sessionId: string) {
      const session = sessions.find((current) => current.id === sessionId);
      if (!session) throw new Error("missing");
      return session;
    },
    async getMessages() {
      return [];
    },
    async prompt(_sessionId: string, text: string) {
      return [
        { id: "u", role: "user", text },
        { id: "a", role: "assistant", text: `Mock response to: ${text}` },
      ];
    },
    async bash(_sessionId: string, command: string) {
      return [{ id: "b", role: "custom", text: command }];
    },
    async abort() {}, 
  };
}

describe("SessionDashboard", () => {
  it("loads with an empty session list", async () => {
    render(<SessionDashboard api={makeApi()} />);
    await screen.findByRole("heading", { name: "pi remote" });
    expect(screen.getByText("Select or create a session.")).toBeInTheDocument();
  });

  it("shows a loading state on the New session button while the session is being created", async () => {
    const createSessionDeferred = deferredPromise<SessionCardData>();
    const api: SessionDashboardApi = {
      ...makeApi(),
      createSession: vi.fn(() => createSessionDeferred.promise),
    };
    render(<SessionDashboard api={api} />);
    await screen.findByRole("heading", { name: "pi remote" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    const creating = screen.getByRole("button", { name: "Creating session" });
    expect(creating).toBeDisabled();
    expect(creating).toHaveAttribute("aria-busy", "true");
    expect(within(creating).getByText(/Creating/)).toBeInTheDocument();

    createSessionDeferred.resolve({
      id: "delayed-session",
      cwd: "/tmp/project",
      status: "idle",
      model: "mock/model",
      tokenSummary: "0 tokens",
      lastActivity: Date.now(),
    });
    await screen.findByLabelText("Prompt draft");
    await waitFor(() => expect(screen.getByRole("button", { name: "New session" })).not.toBeDisabled());
  });

  it("clicking 'New session' immediately creates a session, focuses the prompt, and shows the inline name input", async () => {
    // The 'New session' modal was replaced by an inline flow: the click
    // immediately spawns a session (cwd = home-or-default), the prompt
    // textarea gets focus, and a small 'name (optional)' input appears
    // above the composer until the first message is sent.
    render(<SessionDashboard api={makeApi()} />);
    await screen.findByRole("heading", { name: "pi remote" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    // No modal dialog should ever appear.
    expect(screen.queryByRole("dialog", { name: /Create new session|new session/i })).not.toBeInTheDocument();

    // The composer's prompt textarea is now in the DOM and focused.
    const prompt = await screen.findByLabelText("Prompt draft");
    await waitFor(() => expect(document.activeElement).toBe(prompt));

    // The inline name input is visible, starts empty, and uses a
    // standalone placeholder rather than an external 'NAME / OPTIONAL'
    // label — visual styling that matches the prompt textarea.
    const nameInput = screen.getByLabelText("Name this session") as HTMLInputElement;
    expect(nameInput).toBeInTheDocument();
    expect(nameInput.value).toBe("");
    expect(nameInput.placeholder).toMatch(/optionally name this session/i);
    // No external 'NAME' / 'optional' label should be in the DOM — the
    // hint lives inside the input as placeholder text.
    expect(screen.queryByText(/^name$/i)).toBeNull();
    expect(screen.queryByText(/^optional$/i)).toBeNull();
    // The row renders a writing-icon affordance next to the input so the
    // user can tell at a glance that the area is editable. The wrapper
    // also drops the bordered card background so the field reads as a
    // lighter, secondary affordance below the prompt composer.
    const row = nameInput.closest(".session-name-row");
    expect(row, "name input should live inside .session-name-row").not.toBeNull();
    expect(row!.querySelector("svg"), ".session-name-row should include a pencil-style svg icon").not.toBeNull();
    // The borderless variant no longer wraps the input in the rounded
    // .session-name-field card.
    expect(row!.querySelector(".session-name-field")).toBeNull();
  });

  it("polls session statuses without selecting sessions", async () => {
    const statusSnapshot: readonly SessionCardData[] = [{ id: "s1", cwd: "/repo/app", sessionName: "Active elsewhere", status: "streaming", lastActivity: 2 }];
    const api = {
      ...makeApi([{ id: "s1", cwd: "/repo/app", sessionName: "Active elsewhere", status: "idle", lastActivity: 1 }]),
      listSessionStatuses: vi.fn(async () => statusSnapshot),
    } satisfies SessionDashboardApi;
    const { container } = render(<SessionDashboard api={api} />);
    await screen.findByText("Active elsewhere");
    expect(screen.getByText("Select or create a session.")).toBeInTheDocument();

    await waitFor(() => expect(api.listSessionStatuses).toHaveBeenCalled());
    expect(container.querySelector(".session-row-dot.streaming")).toBeInTheDocument();
    expect(screen.getByText("Select or create a session.")).toBeInTheDocument();
  });

  it("does not reorder the sidebar when status polling reports fresh timestamps or a streaming status", async () => {
    // Regression pin for the sidebar-thrash bug introduced by PR #77 and
    // reverted here. Two distinct triggers we have to be defensive about,
    // both fired together when this fails:
    //   (a) status polls take whatever lastActivity the snapshot reports,
    //       overwriting the client-side value and shuffling Recent order
    //       on every 4s poll for every session;
    //   (b) status itself was used as the primary sort key, so a session
    //       flipping streaming ↔ idle yanked rows up by N slots and back.
    // Real activity events (prompt, SSE, fork, rename) still move rows
    // through other code paths.
    const statusPoll = deferredPromise<readonly SessionCardData[]>();
    const api = {
      ...makeApi([
        { id: "newer", cwd: "/repo/newer", sessionName: "Newer", status: "idle", lastActivity: 20 },
        { id: "older", cwd: "/repo/older", sessionName: "Older", status: "idle", lastActivity: 10 },
      ]),
      listSessionStatuses: vi.fn(() => statusPoll.promise),
    } satisfies SessionDashboardApi;
    render(<SessionDashboard api={api} />);
    await screen.findByText("Newer");
    expect(sessionListButtonNames()).toEqual(["Newer", "Older"]);

    // Snapshot reports: Older's lastActivity jumped past Newer's (Cause B)
    // AND Older is now streaming while Newer is idle (Cause A). With the
    // pre-fix code this would have put Older at the top on both counts.
    statusPoll.resolve([
      { id: "newer", cwd: "/repo/newer", sessionName: "Newer", status: "idle", lastActivity: 21 },
      { id: "older", cwd: "/repo/older", sessionName: "Older", status: "streaming", lastActivity: 999 },
    ]);
    await waitFor(() => expect(api.listSessionStatuses).toHaveBeenCalled());

    expect(sessionListButtonNames()).toEqual(["Newer", "Older"]);
  });

  it("Recent sort: only user-driven activity (handlePrompt) moves a row; LLM/tool/poll updates do NOT", async () => {
    // Contract pinned here: 'Recent' is the last time the user submitted
    // input on this client. Server-driven ticks (LLM streaming, tool
    // execution, status polling, session-index mtime drift) MUST NOT
    // reorder the sidebar.
    if (typeof window !== "undefined" && window.localStorage) window.localStorage.clear();

    const statusPoll = deferredPromise<readonly SessionCardData[]>();
    const api = {
      ...makeApi([
        // Two rows. 'Older' has the LATER server-side lastActivity so the
        // pre-fix Recent sort would have put it on top. We want the order
        // here to be 'Newer first' once the user has touched it.
        { id: "newer", cwd: "/repo/newer", sessionName: "Newer", status: "idle", lastActivity: 10 },
        { id: "older", cwd: "/repo/older", sessionName: "Older", status: "idle", lastActivity: 1_000_000 },
      ]),
      listSessionStatuses: vi.fn(() => statusPoll.promise),
    } satisfies SessionDashboardApi;
    render(<SessionDashboard api={api} />);
    // Initial order seeds from server lastActivity — 'Older' wins.
    await screen.findByText("Older");
    expect(sessionListButtonNames()).toEqual(["Older", "Newer"]);

    // User selects 'Newer' and submits a prompt — that's the canonical
    // user-activity bump. Now 'Newer' should pop to the top.
    fireEvent.click(screen.getByRole("button", { name: /Newer/ }));
    fireEvent.change(await screen.findByLabelText("Prompt draft"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sessionListButtonNames()).toEqual(["Newer", "Older"]));

    // Now simulate the server reporting 'Older' as streaming with a
    // wildly newer lastActivity — the kind of update PR #77 used to act
    // on. The sidebar must stay put because no user activity happened.
    statusPoll.resolve([
      { id: "newer", cwd: "/repo/newer", sessionName: "Newer", status: "idle", lastActivity: 11 },
      { id: "older", cwd: "/repo/older", sessionName: "Older", status: "streaming", lastActivity: 9_999_999_999 },
    ]);
    await waitFor(() => expect(api.listSessionStatuses).toHaveBeenCalled());
    expect(sessionListButtonNames()).toEqual(["Newer", "Older"]);
  });

  describe("Recent sort contract: server-authored last user input", () => {
    it("orders by lastUserActivity, not assistant/tool/status activity, so a 24h worker does not outrank a fresh user prompt", async () => {
      if (typeof window !== "undefined" && window.localStorage) window.localStorage.clear();

      render(<SessionDashboard api={makeApi([
        {
          id: "long-worker",
          cwd: "/repo/worker",
          sessionName: "Agent working for 24h",
          status: "streaming",
          // Assistant/tool activity is very recent, but the user has not
          // touched this session in a long time. This must not win Recent.
          lastActivity: 1_000_000,
          lastUserActivity: 100,
          createdAt: 50,
        },
        {
          id: "cron-today",
          cwd: "/repo/cron",
          sessionName: "cron: qxo briefing",
          status: "idle",
          lastActivity: 200_000,
          // Scheduled prompts are still user-input messages, but older than
          // the user's fresh WGNR prompt below.
          lastUserActivity: 500,
          createdAt: 400,
        },
        {
          id: "wgnr",
          cwd: "/repo/wgnr",
          sessionName: "wgnr-pi vs prc",
          status: "compacting",
          lastActivity: 600,
          lastUserActivity: 900,
          createdAt: 300,
        },
      ])} />);

      await screen.findByText("wgnr-pi vs prc");
      expect(sessionListButtonNames()).toEqual([
        "wgnr-pi vs prc",
        "cron: qxo briefing",
        "Agent working for 24h",
      ]);
    });

    it("lets a status snapshot promote a session when the server has observed a newer user input", async () => {
      if (typeof window !== "undefined" && window.localStorage) window.localStorage.clear();
      const statusPoll = deferredPromise<readonly SessionCardData[]>();
      const api = {
        ...makeApi([
          { id: "old-top", cwd: "/repo/a", sessionName: "Previously recent", status: "idle", lastActivity: 200, lastUserActivity: 200, createdAt: 1 },
          { id: "wgnr", cwd: "/repo/w", sessionName: "wgnr-pi vs prc", status: "idle", lastActivity: 100, lastUserActivity: 100, createdAt: 1 },
        ]),
        listSessionStatuses: vi.fn(() => statusPoll.promise),
      } satisfies SessionDashboardApi;

      render(<SessionDashboard api={api} />);
      await screen.findByText("Previously recent");
      expect(sessionListButtonNames()).toEqual(["Previously recent", "wgnr-pi vs prc"]);

      statusPoll.resolve([
        { id: "old-top", cwd: "/repo/a", sessionName: "Previously recent", status: "idle", lastActivity: 300, lastUserActivity: 200, createdAt: 1 },
        { id: "wgnr", cwd: "/repo/w", sessionName: "wgnr-pi vs prc", status: "compacting", lastActivity: 9_999, lastUserActivity: 900, createdAt: 1 },
      ]);

      await waitFor(() => expect(api.listSessionStatuses).toHaveBeenCalled());
      expect(sessionListButtonNames()).toEqual(["wgnr-pi vs prc", "Previously recent"]);
    });

    it("does not let stale browser localStorage pin an old session above newer server-side user input", async () => {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.clear();
        window.localStorage.setItem("pi-remote-control:lastUserActivityById:v1", JSON.stringify({
          "stale-local": 10_000,
        }));
      }

      render(<SessionDashboard api={makeApi([
        { id: "stale-local", cwd: "/repo/old", sessionName: "Stale localStorage winner", status: "idle", lastActivity: 100, lastUserActivity: 100, createdAt: 1 },
        { id: "server-new", cwd: "/repo/new", sessionName: "Server newer prompt", status: "idle", lastActivity: 200, lastUserActivity: 900, createdAt: 1 },
      ])} />);

      await screen.findByText("Server newer prompt");
      expect(sessionListButtonNames()).toEqual(["Server newer prompt", "Stale localStorage winner"]);
    });

    it("uses createdAt as a deterministic tie-breaker for sessions with identical scheduled input timestamps", async () => {
      if (typeof window !== "undefined" && window.localStorage) window.localStorage.clear();

      render(<SessionDashboard api={makeApi([
        { id: "older-cron", cwd: "/repo/cron", sessionName: "Alpha older cron", status: "idle", lastActivity: 1_000, lastUserActivity: 500, createdAt: 100 },
        { id: "newer-cron", cwd: "/repo/cron", sessionName: "Beta newer cron", status: "idle", lastActivity: 1_000, lastUserActivity: 500, createdAt: 200 },
      ])} />);

      await screen.findByText("Alpha older cron");
      expect(sessionListButtonNames()).toEqual(["Beta newer cron", "Alpha older cron"]);
    });
  });

  it("Recent sort: localStorage persistence preserves user-driven order across reloads", async () => {
    if (typeof window !== "undefined" && window.localStorage) window.localStorage.clear();

    const initial = [
      { id: "a", cwd: "/repo/a", sessionName: "Alpha", status: "idle" as const, model: "m", lastActivity: 100 },
      { id: "b", cwd: "/repo/b", sessionName: "Beta",  status: "idle" as const, model: "m", lastActivity: 200 },
    ];
    const first = render(<SessionDashboard api={makeApi(initial)} />);
    await screen.findByText("Beta");
    expect(sessionListButtonNames()).toEqual(["Beta", "Alpha"]);

    // User prompts 'Alpha' — it goes to the top.
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    fireEvent.change(await screen.findByLabelText("Prompt draft"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sessionListButtonNames()).toEqual(["Alpha", "Beta"]));

    // Unmount and re-render with a fresh API. localStorage should carry
    // the user-activity map so 'Alpha' remains on top. Clear the active
    // session from the URL so the second render starts from the sidebar
    // list rather than re-opening the same session (which would double
    // up the 'Alpha' DOM nodes between sidebar row and active-session h2).
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("session");
      window.history.replaceState(null, "", url.toString());
    }
    first.unmount();
    render(<SessionDashboard api={makeApi(initial)} />);
    await waitFor(() => expect(sessionListButtonNames()).toEqual(["Alpha", "Beta"]));
  });

  it("the inline name input disappears once the first message is sent", async () => {
    const handlers = renderDashboardCapturingPrompts();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    await screen.findByLabelText("Name this session");

    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(handlers.promptCalls.length).toBe(1));
    await waitFor(() => expect(screen.queryByLabelText("Name this session")).not.toBeInTheDocument());
  });

  it("typing in the inline name input and sending a prompt renames the session", async () => {
    const handlers = renderDashboardCapturingPrompts();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const nameInput = await screen.findByLabelText("Name this session") as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: "Feature work" } });
    // The inline name input commits on blur — simulating the user moving
    // focus from the name field to the prompt textarea before sending.
    fireEvent.blur(nameInput);
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "start" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(handlers.renameCalls.length).toBe(1));
    expect(handlers.renameCalls[0]!.name).toBe("Feature work");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Feature work" })).toBeInTheDocument());
  });

  it("searches, toggles paths, filters named sessions, and sorts", async () => {
    render(<SessionDashboard api={makeApi([
      { id: "b", cwd: "/repo/b", sessionName: "Beta", status: "streaming", model: "m", lastActivity: 2 },
      { id: "a", cwd: "/repo/a", status: "idle", model: "m", lastActivity: 1 },
    ])} />);

    await screen.findByRole("heading", { name: "pi remote" });
    fireEvent.change(screen.getByPlaceholderText("Search sessions"), { target: { value: "Beta" } });
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Untitled session")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Filter sessions" }));
    fireEvent.click(screen.getByLabelText("Named only"));
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("a")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show paths"));
    expect(screen.getByText("/repo/b")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Sort sessions"), { target: { value: "name" } });
    expect(screen.getByLabelText("Sort sessions")).toHaveValue("name");
    fireEvent.click(screen.getByRole("button", { name: "Filter sessions" }));
  });

  it("renders non-zero token and cost stats in the composer status row", async () => {
    render(<SessionDashboard api={makeApi([{
      id: "stats",
      cwd: "/repo/stats",
      sessionName: "Stats",
      status: "idle",
      model: "mock/model",
      lastActivity: 1,
      stats: {
        inputTokens: 12_345,
        outputTokens: 6_789,
        cacheReadTokens: 22_222,
        cacheWriteTokens: 3_333,
        cost: 0.9876,
        contextTokens: 42_424,
        contextPercent: 42,
        contextWindow: 1_000_000,
      },
    }])} />);

    await screen.findByText("Stats");
    fireEvent.click(screen.getByRole("button", { name: /Stats/ }));

    const status = await screen.findByLabelText("Session status");
    expect(status).toHaveTextContent("↑12k");
    expect(status).toHaveTextContent("↓6.8k");
    expect(status).toHaveTextContent("r22k");
    expect(status).toHaveTextContent("w3.3k");
    expect(status).toHaveTextContent("$0.9876");
    expect(status).toHaveTextContent("42%");
    expect(status).toHaveTextContent("1.0M");
  });

  it("rounds fractional context usage percent in the composer status row", async () => {
    render(<SessionDashboard api={makeApi([{
      id: "stats",
      cwd: "/repo/stats",
      sessionName: "Stats",
      status: "idle",
      model: "mock/model",
      lastActivity: 1,
      stats: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        cost: 0.01,
        contextTokens: 12_345,
        contextPercent: 12.3456789012345,
        contextWindow: 1_000_000,
      },
    }])} />);

    await screen.findByText("Stats");
    fireEvent.click(screen.getByRole("button", { name: /Stats/ }));

    const status = await screen.findByLabelText("Session status");
    expect(status).toHaveTextContent("12%");
    expect(status).not.toHaveTextContent("12.3456789012345%");
  });

  it("does not reorder the session list just because a session was selected", async () => {
    const initial: SessionCardData[] = [
      { id: "newer", cwd: "/repo/newer", sessionName: "Newer", status: "idle", model: "m", lastActivity: 20 },
      { id: "older", cwd: "/repo/older", sessionName: "Older", status: "idle", model: "m", lastActivity: 10 },
    ];
    const api = {
      ...makeApi(initial),
      async getSession(sessionId: string) {
        const session = initial.find((current) => current.id === sessionId);
        if (!session) throw new Error("missing");
        return { ...session, lastActivity: 999 };
      },
    } satisfies SessionDashboardApi;

    render(<SessionDashboard api={api} />);
    await screen.findByText("Newer");
    expect(sessionListButtonNames()).toEqual(["Newer", "Older"]);

    fireEvent.click(screen.getByRole("button", { name: /Older/ }));
    await screen.findByRole("heading", { name: "Older" });

    await waitFor(() => expect(sessionListButtonNames()).toEqual(["Newer", "Older"]));
  });

  it("renders thinking only inside the Thought card during streaming — not double-rendered into the assistant bubble on message_end", async () => {
    // Production repro: a thinking_delta + text_delta stream populates the
    // assistant message's `thinking` (Thought card) and `text` (bubble)
    // separately. Then a `message_end` event arrives with the full
    // WireMessage containing both kinds of content blocks. The previous
    // wireMessageToTimeline mapped that combined `content` through
    // contentText() which flattened text + thinking into a single string
    // — so the bubble briefly showed the thinking content again until the
    // next history reload corrected it.
    let pushEvent: ((event: unknown) => void) | undefined;
    const api = {
      ...makeApi([
        { id: "a", cwd: "/repo/a", sessionName: "Live", status: "idle", model: "m", lastActivity: 1 },
      ]),
      async getMessages() {
        return [];
      },
      streamEvents(_sessionId: string, onEvent: (event: unknown) => void) {
        pushEvent = onEvent;
        return () => undefined;
      },
    } satisfies SessionDashboardApi;

    render(<SessionDashboard api={api} />);
    await screen.findByText("Live");
    fireEvent.click(screen.getByRole("button", { name: /Live/ }));
    await waitFor(() => expect(pushEvent).toBeDefined());

    const THINKING = "Exploring BigQuery options";
    const VISIBLE = "Let me list the tables.";

    // Two streaming deltas accumulate the thinking and visible text
    // separately — normal happy path.
    act(() => {
      pushEvent?.({
        type: "message_update",
        message: { role: "assistant", content: "" },
        assistantMessageEvent: { type: "thinking_delta", delta: THINKING },
      });
    });
    act(() => {
      pushEvent?.({
        type: "message_update",
        message: { role: "assistant", content: "" },
        assistantMessageEvent: { type: "text_delta", delta: VISIBLE },
      });
    });

    // Now the provider sends message_end with the full WireMessage — a
    // content array carrying BOTH a thinking block and a text block.
    act(() => {
      pushEvent?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: THINKING },
            { type: "text", text: VISIBLE },
          ],
        },
      });
    });

    // Make sure SOMETHING from the stream landed first — the visible
    // text in the assistant bubble.
    await waitFor(() => expect(screen.getByText(VISIBLE)).toBeInTheDocument());

    // Bubble must NOT contain the thinking; thinking-block MUST.
    const bubble = document.querySelector(".message-card.assistant .message-bubble") as HTMLElement | null;
    const thinkingBlock = document.querySelector(".thinking-block") as HTMLElement | null;
    expect(bubble, "assistant bubble should be present").not.toBeNull();
    expect(thinkingBlock, "thinking-block should be present").not.toBeNull();
    // Helpful diagnostic when this assertion fails: dump where the
    // thinking text leaked to.
    if ((bubble!.textContent ?? "").includes(THINKING)) {
      console.log("[leak] bubble.textContent:", bubble!.textContent);
      console.log("[leak] thinking-block.textContent:", thinkingBlock!.textContent);
    }
    expect(bubble!.textContent ?? "").not.toContain(THINKING);
    expect(thinkingBlock!.textContent ?? "").toContain(THINKING);
    // And the visible text is in the bubble.
    expect(bubble!.textContent ?? "").toContain(VISIBLE);
  });

  it("applies Pi text deltas from SSE without waiting for message refresh", async () => {
    let pushEvent: ((event: unknown) => void) | undefined;
    const api = {
      ...makeApi([
        { id: "a", cwd: "/repo/a", sessionName: "Live", status: "idle", model: "m", lastActivity: 1 },
      ]),
      async getMessages() {
        return [];
      },
      streamEvents(_sessionId: string, onEvent: (event: unknown) => void) {
        pushEvent = onEvent;
        return () => undefined;
      },
    } satisfies SessionDashboardApi;

    render(<SessionDashboard api={api} />);
    await screen.findByText("Live");
    fireEvent.click(screen.getByRole("button", { name: /Live/ }));
    await waitFor(() => expect(pushEvent).toBeDefined());

    act(() => {
      pushEvent?.({
        type: "message_update",
        message: { role: "assistant", content: "" },
        assistantMessageEvent: { type: "text_delta", delta: "Hel" },
      });
    });
    expect(screen.getByText("Hel")).toBeInTheDocument();

    act(() => {
      pushEvent?.({
        type: "message_update",
        message: { role: "assistant", content: "" },
        assistantMessageEvent: { type: "text_delta", delta: "lo" },
      });
    });
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("streams tool output and artifact metadata from SSE events", async () => {
    let pushEvent: ((event: unknown) => void) | undefined;
    const api = {
      ...makeApi([
        { id: "a", cwd: "/repo/a", sessionName: "Live", status: "idle", model: "m", lastActivity: 1 },
      ]),
      async getMessages() {
        return [];
      },
      streamEvents(_sessionId: string, onEvent: (event: unknown) => void) {
        pushEvent = onEvent;
        return () => undefined;
      },
    } satisfies SessionDashboardApi;

    render(<SessionDashboard api={api} />);
    await screen.findByText("Live");
    fireEvent.click(screen.getByRole("button", { name: /Live/ }));
    await waitFor(() => expect(pushEvent).toBeDefined());

    act(() => {
      pushEvent?.({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
    });
    expect(screen.getByLabelText("tool bash")).toHaveTextContent("running");

    act(() => {
      pushEvent?.({
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls" },
        partialResult: { content: [{ type: "text", text: "package" }] },
      });
    });
    expect(screen.getByText("package")).toBeInTheDocument();

    act(() => {
      pushEvent?.({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "package.json" }],
          details: { piRemoteControlArtifact: { kind: "markdown", title: "Report", markdown: "## Done" } },
        },
        isError: false,
      });
    });
    expect(screen.getByLabelText("tool bash")).toHaveTextContent("package.json");
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText("Report")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();
  });

  it("renders extension UI requests from SSE and sends responses", async () => {
    let pushEvent: ((event: unknown) => void) | undefined;
    const responses: ExtensionUiResponse[] = [];
    const api = {
      ...makeApi([
        { id: "a", cwd: "/repo/a", sessionName: "Live", status: "idle", model: "m", lastActivity: 1 },
      ]),
      streamEvents(_sessionId: string, onEvent: (event: unknown) => void) {
        pushEvent = onEvent;
        return () => undefined;
      },
      async respondToExtensionUi(_sessionId: string, response: ExtensionUiResponse) {
        responses.push(response);
      },
    } satisfies SessionDashboardApi;

    render(<SessionDashboard api={api} />);
    await screen.findByText("Live");
    fireEvent.click(screen.getByRole("button", { name: /Live/ }));
    await waitFor(() => expect(pushEvent).toBeDefined());

    act(() => {
      pushEvent?.({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Continue?", message: "Proceed" });
    });

    expect(screen.getByRole("dialog", { name: "Continue?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(responses).toEqual([{ id: "ui-1", confirmed: true }]));
    expect(screen.queryByRole("dialog", { name: "Continue?" })).not.toBeInTheDocument();
  });

  it("fork button opens fork picker and restores selected prompt in the new session", async () => {
    const forked: SessionCardData = { id: "forked", cwd: "/repo/a", sessionName: "Forked", status: "idle", model: "m", lastActivity: 2 };
    const api = {
      ...makeApi([{ id: "a", cwd: "/repo/a", sessionName: "Original", status: "idle", model: "m", lastActivity: 1 }]),
      async getForkMessages() {
        return [{ entryId: "entry-1", text: "original prompt text" }];
      },
      async forkSession(_sessionId: string, entryId: string) {
        expect(entryId).toBe("entry-1");
        return { cancelled: false, text: "original prompt text", session: forked };
      },
    } satisfies SessionDashboardApi;

    render(<SessionDashboard api={api} />);
    await screen.findByText("Original");
    fireEvent.click(screen.getByRole("button", { name: /Original/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Fork" }));

    await screen.findByRole("dialog", { name: "Fork session" });
    fireEvent.click(screen.getByRole("button", { name: /original prompt text/ }));

    await screen.findByRole("heading", { name: "Forked" });
    await waitFor(() => expect(screen.getByLabelText("Prompt draft")).toHaveValue("original prompt text"));
    expect(screen.getByText(/ready to edit/i)).toBeInTheDocument();
  });

  it("/fork with an index forks without using the picker", async () => {
    const forked: SessionCardData = { id: "forked", cwd: "/repo/a", sessionName: "Forked", status: "idle", model: "m", lastActivity: 2 };
    const api = {
      ...makeApi([{ id: "a", cwd: "/repo/a", sessionName: "Original", status: "idle", model: "m", lastActivity: 1 }]),
      async getForkMessages() {
        return [{ entryId: "entry-1", text: "first prompt" }, { entryId: "entry-2", text: "second prompt" }];
      },
      async forkSession(_sessionId: string, entryId: string) {
        expect(entryId).toBe("entry-2");
        return { cancelled: false, text: "second prompt", session: forked };
      },
    } satisfies SessionDashboardApi;

    render(<SessionDashboard api={api} />);
    await screen.findByText("Original");
    fireEvent.click(screen.getByRole("button", { name: /Original/ }));
    fireEvent.change(await screen.findByLabelText("Prompt draft"), { target: { value: "/fork 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByRole("heading", { name: "Forked" });
    expect(screen.queryByRole("dialog", { name: "Fork session" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Prompt draft")).toHaveValue("second prompt"));
  });

  it("/clear is an alias for /new and starts a fresh session", async () => {
    // pi renamed /clear -> /new (see pi-coding-agent CHANGELOG). The WUI keeps
    // /clear working as a muscle-memory alias for users coming from Claude
    // Code et al.
    const createSession = vi.fn(async (input: NewSessionInput) => ({
      id: "freshly-cleared",
      cwd: input.cwd,
      ...(input.sessionName === undefined ? {} : { sessionName: input.sessionName }),
      status: "idle" as const,
      model: "mock/model",
      tokenSummary: "0 tokens",
      lastActivity: Date.now(),
    }));
    const api = {
      ...makeApi([{ id: "a", cwd: "/repo/a", sessionName: "Original", status: "idle", model: "m", lastActivity: 1 }]),
      createSession,
    } satisfies SessionDashboardApi;

    render(<SessionDashboard api={api} />);
    await screen.findByText("Original");
    fireEvent.click(screen.getByRole("button", { name: /Original/ }));
    fireEvent.change(await screen.findByLabelText("Prompt draft"), { target: { value: "/clear" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // The /clear text must NOT have been sent to the model as a prompt.
    await waitFor(() => expect(screen.getByLabelText("Prompt draft")).toHaveValue(""));
    expect(screen.queryByText(/Mock response to: \/clear/)).not.toBeInTheDocument();
  });

  it("disables unimplemented top-right session action buttons", async () => {
    render(<SessionDashboard api={makeApi([
      { id: "a", cwd: "/repo/a", sessionName: "Original", status: "idle", model: "m", lastActivity: 1 },
    ])} />);
    await screen.findByText("Original");
    fireEvent.click(screen.getByRole("button", { name: /Original/ }));

    expect(await screen.findByRole("button", { name: "Compact" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tree" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clone" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Fork" })).toBeEnabled();
  });

  it("renames the active session via the inline form", async () => {
    render(<SessionDashboard api={makeApi([
      { id: "a", cwd: "/repo/a", sessionName: "Original", status: "idle", model: "m", lastActivity: 1 },
    ])} />);
    await screen.findByText("Original");
    fireEvent.click(screen.getByRole("button", { name: /Original/ }));

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Session name");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Renamed" });
  });

  it("refuses to send messages larger than the size cap", async () => {
    let promptCalls = 0;
    const api: any = {
      ...makeApi([{ id: "a", cwd: "/repo/a", sessionName: "Original", status: "idle", model: "m", lastActivity: 1 }]),
      prompt: async () => {
        promptCalls += 1;
        return [];
      },
    };
    render(<SessionDashboard api={api} />);
    await screen.findByText("Original");
    fireEvent.click(screen.getByRole("button", { name: /Original/ }));

    const huge = "x".repeat(40_000);
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: huge } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(promptCalls).toBe(0);
    expect(screen.getByRole("alert", { name: "Prompt error" })).toHaveTextContent(/limit is 32,000/);
  });

  it("returns from the cron view when a session is clicked in the sidebar", async () => {
    const cron = {
      list: vi.fn(async () => ({ jobs: [], filePath: "/cron.json" })),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(),
    };
    const api: SessionDashboardApi = {
      ...makeApi([
        { id: "a", cwd: "/repo/a", sessionName: "Alpha", status: "idle", model: "m", lastActivity: 1 },
      ]),
      cron,
    };
    render(<SessionDashboard api={api} />);
    await screen.findByText("Alpha");

    // Enter the cron view (sidebar label is 'Schedule').
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await screen.findByRole("heading", { name: "Schedule" });

    // Click a session in the sidebar — should leave the cron view and show
    // the active-session pane. Previously the cron panel stayed mounted
    // because only activeSessionId changed, leaving the user stuck on cron.
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Schedule" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
  });

  it("shows the spawned session after 'Run now' even when its cwd is outside defaultCwd", async () => {
    // Repro: cron jobs commonly run with a cwd different from the project
    // root the dashboard was loaded with (e.g. cron cwd is /home/coder but the
    // dashboard's defaultCwd is /home/coder/code/pi-remote-control). The cron
    // 'Run now' flow then calls onOpenSession(spawnedId), but listSessions
    // (which is filtered by defaultCwd server-side) won't include that
    // spawned session, leaving the user stuck on the cron page with an empty
    // active-session pane.
    const cron = {
      list: vi.fn(async () => ({
        jobs: [{
          id: "j1",
          name: "dependabot",
          schedule: "0 13 * * *",
          prompt: "do stuff",
          cwd: "/elsewhere",
          enabled: true,
          lastRun: null,
          nextRun: Date.now() + 60_000,
          lastSessionId: null,
          scheduleError: null,
        }],
        filePath: "/cron.json",
      })),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(async () => ({
        job: {
          id: "j1",
          name: "dependabot",
          schedule: "0 13 * * *",
          prompt: "do stuff",
          cwd: "/elsewhere",
          enabled: true,
          lastRun: Date.now(),
          nextRun: Date.now() + 60_000,
          lastSessionId: "spawned-z",
          scheduleError: null,
        },
        sessionId: "spawned-z",
        sessionFile: "/elsewhere/.pi/spawned-z.jsonl",
      })),
    };
    const base = makeApi([
      { id: "a", cwd: "/repo/main", sessionName: "Alpha", status: "idle", model: "m", lastActivity: 1 },
    ]);
    const api: SessionDashboardApi = {
      ...base,
      // Dashboard's defaultCwd in this test is "/tmp/project" (the fallback),
      // and listSessions does not know about /elsewhere sessions — just like
      // production filters by defaultCwd. The dashboard must still navigate
      // to the spawned session by fetching it explicitly.
      async getSession(sessionId) {
        if (sessionId === "spawned-z") {
          return { id: "spawned-z", cwd: "/elsewhere", sessionName: "cron: dependabot", status: "idle", model: "m", lastActivity: 2 };
        }
        return base.getSession ? base.getSession(sessionId) : Promise.reject(new Error("missing"));
      },
      cron,
    };
    render(<SessionDashboard api={api} />);
    await screen.findByText("Alpha");

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await screen.findByRole("heading", { name: "Schedule" });
    await screen.findByText("dependabot");

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    // After the run-now resolves, the dashboard should switch to the sessions
    // view AND surface the spawned session as the active session, even though
    // it isn't in the filtered listSessions response.
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Schedule" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "cron: dependabot" })).toBeInTheDocument();
  });

  it("requires explicit confirmation before deleting and supports cancel", async () => {
    render(<SessionDashboard api={makeApi([
      { id: "a", cwd: "/repo/a", sessionName: "Doomed", status: "idle", model: "m", lastActivity: 1 },
    ])} />);
    await screen.findByText("Doomed");
    fireEvent.click(screen.getByRole("button", { name: /Doomed/ }));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog", { name: "Delete session" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog", { name: "Delete session" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Doomed" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.queryByText("Doomed")).not.toBeInTheDocument());
  });
  it("drains queued follow-up messages when the session goes idle", async () => {
    // Production repro: user clicks Send while the agent is streaming, the
    // composer routes that text into onFollowUp (the 'queue for later'
    // bucket), the queue chip appears in the composer footer — but when
    // the session finishes and goes idle, nothing ever submits the queued
    // text. The user is left staring at a 'Follow-up: …' chip forever.
    //
    // This test gates the prompt() promise so we can enqueue while the
    // session is streaming, then asserts that releasing the prompt (→ idle)
    // automatically fires api.prompt(...) for the queued message.

    let resolveFirst: ((value: readonly unknown[]) => void) | null = null;
    const promptCalls: Array<{ text: string }> = [];
    const base = makeApi([
      { id: "a", cwd: "/repo/a", sessionName: "Worker", status: "idle", model: "m", lastActivity: 1 },
    ]);
    const api: SessionDashboardApi = {
      ...base,
      async prompt(_sessionId, text) {
        promptCalls.push({ text });
        if (promptCalls.length === 1) {
          // Gate the first prompt so we can enqueue a follow-up while
          // the session is still streaming.
          return new Promise((resolve) => {
            resolveFirst = (v) => resolve(v as never);
          }) as Promise<never>;
        }
        return [
          { id: `u-${promptCalls.length}`, role: "user", text },
          { id: `a-${promptCalls.length}`, role: "assistant", text: `Mock response to: ${text}` },
        ];
      },
    };
    render(<SessionDashboard api={api} />);
    await screen.findByText("Worker");
    fireEvent.click(screen.getByRole("button", { name: /Worker/ }));
    await screen.findByRole("heading", { name: "Worker" });

    // First prompt: send 'work on it' — this stays in flight.
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "work on it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(promptCalls).toHaveLength(1));

    // While streaming, queue a follow-up via the composer (clicking Send
    // during streaming routes the text into onFollowUp).
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "then test it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("Message queues")).toHaveTextContent("Follow-up: then test it");

    // Release the first prompt → session goes idle. The queued follow-up
    // should now flush automatically, producing a second api.prompt call.
    expect(resolveFirst).not.toBeNull();
    await act(async () => {
      resolveFirst!([
        { id: "u-1", role: "user", text: "work on it" },
        { id: "a-1", role: "assistant", text: "Mock response to: work on it" },
      ]);
    });

    await waitFor(() => expect(promptCalls).toHaveLength(2));
    expect(promptCalls[1]!.text).toBe("then test it");
    // The queue chip disappears once empty (the <ul aria-label='Message
    // queues'> only renders when there's something in the queues), so the
    // post-drain assertion checks the label is gone entirely.
    await waitFor(() => expect(screen.queryByLabelText("Message queues")).toBeNull());
  });

  it("drains multiple queued follow-up messages in order across successive idles", async () => {
    let resolveCurrent: ((value: readonly unknown[]) => void) | null = null;
    const promptCalls: Array<{ text: string }> = [];
    const base = makeApi([
      { id: "a", cwd: "/repo/a", sessionName: "Worker", status: "idle", model: "m", lastActivity: 1 },
    ]);
    const api: SessionDashboardApi = {
      ...base,
      async prompt(_sessionId, text) {
        promptCalls.push({ text });
        return new Promise((resolve) => {
          resolveCurrent = (v) => resolve(v as never);
        }) as Promise<never>;
      },
    };
    render(<SessionDashboard api={api} />);
    await screen.findByText("Worker");
    fireEvent.click(screen.getByRole("button", { name: /Worker/ }));
    await screen.findByRole("heading", { name: "Worker" });

    // Start the first prompt.
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "step 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(promptCalls).toHaveLength(1));

    // Queue two follow-ups in order.
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "step 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(screen.getByLabelText("Prompt draft"), { target: { value: "step 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("Message queues")).toHaveTextContent("Follow-up: step 2");
    expect(screen.getByLabelText("Message queues")).toHaveTextContent("Follow-up: step 3");

    // Each prompt() captures a *new* deferred resolver (the closure-on-let
    // pattern below), so the drained follow-up replaces the gated promise.
    // Drive the idle->drain cycle one step at a time and snapshot the
    // resolver before releasing.
    async function releaseAndFlush() {
      const release = resolveCurrent!;
      await act(async () => { release([]); });
    }

    // Idle the first prompt → step 2 should fire.
    await releaseAndFlush();
    await waitFor(() => expect(promptCalls.map((c) => c.text)).toEqual(["step 1", "step 2"]));

    // Idle the second prompt → step 3 should fire.
    await releaseAndFlush();
    await waitFor(() => expect(promptCalls.map((c) => c.text)).toEqual(["step 1", "step 2", "step 3"]));

    // After step 3 resolves the queue is empty and the chip disappears.
    await releaseAndFlush();
    await waitFor(() => expect(screen.queryByLabelText("Message queues")).toBeNull());
  });
});

function sessionListButtonNames(): string[] {
  return within(screen.getByRole("list")).getAllByRole("button").map((button) => button.querySelector(".session-row-name")?.textContent ?? "");
}
