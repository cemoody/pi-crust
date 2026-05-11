// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
  }
});
import { SessionDashboard } from "../../src/web/components/SessionDashboard.js";
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
    await screen.findByText("0 sessions");
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

    await screen.findByText("2 sessions");
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
