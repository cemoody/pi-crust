// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCardData, SessionDashboardApi, NewSessionInput } from "../../src/web/api/session-api.js";

vi.mock("../../src/web/components/MessageTimeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/web/components/MessageTimeline.js")>();
  return {
    ...actual,
    MessageTimeline: vi.fn(() => <div data-testid="mock-message-timeline" />),
  };
});

import { SessionDashboard } from "../../src/web/components/SessionDashboard.js";
import { MessageTimeline } from "../../src/web/components/MessageTimeline.js";

const renderTimeline = vi.mocked(MessageTimeline);

beforeEach(() => {
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
  renderTimeline.mockClear();
});

function makeApi(initial: SessionCardData[]): SessionDashboardApi {
  let sessions = [...initial];
  return {
    async getDefaultCwd() {
      return "/repo/default";
    },
    async listSessions() {
      return sessions;
    },
    async createSession(input: NewSessionInput) {
      const created: SessionCardData = {
        id: `created-${sessions.length + 1}`,
        cwd: input.cwd,
        ...(input.sessionName ? { sessionName: input.sessionName } : {}),
        status: "idle",
        lastActivity: Date.now(),
      };
      sessions = [created, ...sessions];
      return created;
    },
    async renameSession(sessionId: string, name: string) {
      sessions = sessions.map((session) => session.id === sessionId ? { ...session, sessionName: name } : session);
      return sessions.find((session) => session.id === sessionId)!;
    },
    async deleteSession() {},
    async getSession(sessionId: string) {
      return sessions.find((session) => session.id === sessionId)!;
    },
    async getMessages() {
      return [{ id: "u", role: "user", text: "hello" }];
    },
    async prompt() {
      return [];
    },
    async bash() {
      return [];
    },
    async abort() {},
  };
}

async function renderActiveDashboard() {
  render(<SessionDashboard api={makeApi([
    { id: "s1", cwd: "/repo/app", sessionName: "Original", status: "idle", lastActivity: 1 },
  ])} />);
  await screen.findByText("Original");
  fireEvent.click(screen.getByRole("link", { name: /Original/ }));
  await screen.findByRole("heading", { name: "Original" });
  await screen.findByTestId("mock-message-timeline");
}

describe("SessionDashboard modal input render isolation", () => {
  it("does not rerender the message timeline while typing in the rename form", async () => {
    await renderActiveDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await screen.findByLabelText("Session name");
    const callsAfterOpening = renderTimeline.mock.calls.length;

    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Renamed slowly" } });

    expect(renderTimeline).toHaveBeenCalledTimes(callsAfterOpening);
  });

  it("does not rerender the message timeline while typing in the inline 'name this session' input", async () => {
    // The 'New session' modal was replaced by an inline flow: clicking the
    // menu spawns a fresh session and renders a small 'name this session'
    // input above the composer. We pin that *typing* into that input keeps
    // MessageTimeline render counts flat — the same isolation guarantee
    // the old dialog had. (Switching to the freshly-created session and
    // the focus-seed effect naturally rerender the timeline a few times;
    // we snapshot the count after those settle and assert keystrokes add
    // zero on top of that.)
    await renderActiveDashboard();
    fireEvent.click(screen.getByRole("link", { name: "New session" }));
    const nameInput = await screen.findByLabelText("Name this session");
    // Allow any post-create batched state updates to flush before we lock
    // in the baseline.
    await waitFor(() => expect(renderTimeline).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsAfterOpening = renderTimeline.mock.calls.length;

    fireEvent.change(nameInput, { target: { value: "A lag-free new session name" } });
    fireEvent.change(nameInput, { target: { value: "A lag-free new session name still" } });

    expect(renderTimeline).toHaveBeenCalledTimes(callsAfterOpening);
  });
});
