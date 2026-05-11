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

  it("creates a session and shows the active session pane", async () => {
    render(<SessionDashboard api={makeApi()} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    await screen.findByRole("dialog", { name: "Create new session" });
    fireEvent.change(screen.getByLabelText("New session cwd"), { target: { value: "/repo/app" } });
    fireEvent.change(screen.getByLabelText("New session name"), { target: { value: "Feature work" } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));

    await screen.findByRole("heading", { name: "Feature work" });
    expect(screen.getByText("/repo/app")).toBeInTheDocument();
    expect(screen.getByText("mock/model")).toBeInTheDocument();
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
});

function sessionListButtonNames(): string[] {
  return within(screen.getByRole("list")).getAllByRole("button").map((button) => button.querySelector(".session-row-name")?.textContent ?? "");
}
