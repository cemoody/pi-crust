// @vitest-environment jsdom
//
// TDD pin (red): every navigable item in the sidebar should be a real
// anchor (`<a href=...>`), not just a `<button>`. That lets the user
// cmd+click (or middle-click) any of them to open the destination in
// a new tab, while preserving the existing single-click in-app behavior
// (the click handler still runs and calls preventDefault for plain
// left-clicks).
//
// Items that must be anchors pointing at "the workspace root" so that
// cmd+clicking opens a fresh tab of the app:
//   - The brand icon (qxo)
//   - The brand title ("agent")
//   - The "New session" menu item
//   - The "Schedule" activity menu item
//   - The "Settings" menu item
//
// Items that must be anchors pointing at the specific session URL so
// that cmd+clicking opens that session in a new tab:
//   - Every row in the session list (href="?session=<id>")
//
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDashboard } from "../../src/web/components/SessionDashboard.js";
import type {
  NewSessionInput,
  SessionCardData,
  SessionDashboardApi,
} from "../../src/web/api/session-api.js";

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
  }
  document.title = "";
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg">';
});

function makeApi(initial: SessionCardData[] = []): SessionDashboardApi {
  let sessions = [...initial];
  return {
    async listSessions() { return sessions; },
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
    async renameSession(sessionId, name) {
      sessions = sessions.map((s) => s.id === sessionId ? { ...s, sessionName: name } : s);
      const updated = sessions.find((s) => s.id === sessionId);
      if (!updated) throw new Error("missing");
      return updated;
    },
    async deleteSession(sessionId) {
      sessions = sessions.filter((s) => s.id !== sessionId);
    },
    async getSession(sessionId) {
      const s = sessions.find((current) => current.id === sessionId);
      if (!s) throw new Error("missing");
      return s;
    },
    async getMessages() { return []; },
    async prompt(_sessionId, text) {
      return [
        { id: "u", role: "user", text },
        { id: "a", role: "assistant", text: `mock: ${text}` },
      ];
    },
    async bash(_sessionId, command) {
      return [{ id: "b", role: "custom", text: command }];
    },
    async abort() {},
  };
}

function rootHref(href: string | null | undefined): boolean {
  if (!href) return false;
  // Accept "/", "" or absolute URL whose path is "/" with no session param.
  try {
    const url = new URL(href, window.location.href);
    if (url.pathname !== "/") return false;
    if (url.searchParams.get("session")) return false;
    return true;
  } catch {
    return href === "/" || href === "";
  }
}

function sessionHrefFor(href: string | null | undefined, sessionId: string): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, window.location.href);
    return url.searchParams.get("session") === sessionId;
  } catch {
    return href.includes(`session=${sessionId}`);
  }
}

describe("SessionDashboard sidebar items are anchor links (cmd+click → new tab)", () => {
  it("renders the brand icon and brand title as anchors pointing at the root", async () => {
    const api = {
      ...makeApi(),
      getServerInfo: vi.fn(async () => ({
        gitSha: "abc123",
        adapter: "test",
        projectRoot: "/tmp/project",
        sessionRoot: "/tmp/sessions",
        defaultCwd: "/tmp/project",
        appName: "agent",
        appIcon: "qxo",
      })),
    } satisfies SessionDashboardApi;

    const { container } = render(<SessionDashboard api={api} />);
    const title = await screen.findByRole("heading", { name: "agent" });

    // The title text should be wrapped in (or be) an anchor to root.
    const titleAnchor = title.closest("a") ?? title.querySelector("a");
    expect(titleAnchor, "brand title should be inside an <a> element").not.toBeNull();
    expect(rootHref(titleAnchor?.getAttribute("href"))).toBe(true);

    // The icon should also be inside an anchor to root (could be the same
    // anchor as the title, that's fine — both must be cmd+clickable).
    const icon = container.querySelector(".app-brand-icon");
    expect(icon, "brand icon should be rendered").not.toBeNull();
    const iconAnchor = icon?.closest("a");
    expect(iconAnchor, "brand icon should be inside an <a> element").not.toBeNull();
    expect(rootHref(iconAnchor?.getAttribute("href"))).toBe(true);
  });

  it("renders the 'New session' menu item as an anchor to root", async () => {
    render(<SessionDashboard api={makeApi()} />);
    await screen.findByRole("heading", { name: "π crust" });

    const link = await screen.findByRole("link", { name: /New session/i });
    expect(link.tagName).toBe("A");
    expect(rootHref(link.getAttribute("href"))).toBe(true);
  });

  it("renders the 'Schedule' activity menu item as an anchor to root", async () => {
    const api = {
      ...makeApi(),
      getExtensionSettings: vi.fn(async () => ({
        extensions: {
          commands: [],
          activities: [{ id: "core.schedule.activity", title: "Schedule", extensionId: "core.schedule" }],
          routes: [],
          diagnostics: [],
        },
      })),
    } satisfies SessionDashboardApi;
    render(<SessionDashboard api={api} />);

    const link = await screen.findByRole("link", { name: "Schedule" });
    expect(link.tagName).toBe("A");
    expect(rootHref(link.getAttribute("href"))).toBe(true);
  });

  it("renders the 'Settings' menu item as an anchor to root", async () => {
    const api = {
      ...makeApi(),
      getExtensionSettings: vi.fn(async () => ({
        extensions: { commands: [], activities: [], routes: [], diagnostics: [] },
      })),
    } satisfies SessionDashboardApi;
    render(<SessionDashboard api={api} />);

    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link.tagName).toBe("A");
    expect(rootHref(link.getAttribute("href"))).toBe(true);
  });

  it("renders each session row as an anchor whose href targets that session", async () => {
    const sessions: SessionCardData[] = [
      { id: "session-aaa", cwd: "/repo/one", sessionName: "Untitled session", status: "idle", lastActivity: 3 },
      { id: "session-bbb", cwd: "/repo/two", sessionName: "slides extension preview", status: "idle", lastActivity: 2 },
      { id: "session-ccc", cwd: "/repo/three", sessionName: "debug long session", status: "idle", lastActivity: 1 },
    ];
    const { container } = render(<SessionDashboard api={makeApi(sessions)} />);

    await screen.findByText("slides extension preview");

    const list = container.querySelector(".session-list");
    expect(list, ".session-list should be rendered").not.toBeNull();

    for (const session of sessions) {
      const row = within(list as HTMLElement).getByText(session.sessionName!).closest("li");
      expect(row, `row for ${session.id} should exist`).not.toBeNull();

      const anchor = row!.querySelector("a");
      expect(anchor, `session row ${session.id} should contain an <a>`).not.toBeNull();
      expect(anchor!.tagName).toBe("A");
      expect(
        sessionHrefFor(anchor!.getAttribute("href"), session.id),
        `session row for ${session.id} should link to ?session=${session.id}, got ${anchor!.getAttribute("href")}`,
      ).toBe(true);
    }
  });
});
