// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("bundled schedule web module", () => {
  it("can use host navigation after run-now creates a session", async () => {
    const openSession = vi.fn();
    const cron = {
      list: vi.fn(async () => ({
        jobs: [{ id: "j1", name: "Nightly", schedule: "0 1 * * *", prompt: "run", cwd: "/repo", enabled: true, lastRun: null, nextRun: Date.now(), lastSessionId: null, scheduleError: null }],
        filePath: "/cron.json",
      })),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(async () => ({ job: {}, sessionId: "spawned", sessionFile: "/sessions/spawned.jsonl" })),
    };
    // @ts-expect-error bundled extension web modules are plain JavaScript assets.
    const { renderActivity } = await import("../../extensions/schedule/web.mjs") as { renderActivity: (props: { React: typeof React; api: unknown; navigation?: { openSession(sessionId: string): void } }) => React.ReactNode };

    render(<>{renderActivity({ React, api: { cron }, navigation: { openSession } })}</>);
    await screen.findByText("Nightly");
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    await waitFor(() => expect(openSession).toHaveBeenCalledWith("spawned"));
  });

  it("does not remount and refetch when the host dashboard rerenders", async () => {
    // @ts-expect-error bundled extension web modules are plain JavaScript assets.
    const { renderActivity } = await import("../../extensions/schedule/web.mjs") as { renderActivity: (props: { React: typeof React; api: unknown }) => React.ReactNode };
    const cron = {
      list: vi.fn(async () => ({ jobs: [], filePath: "/cron.json" })),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(),
    };

    function Host() {
      const [renders, setRenders] = React.useState(0);
      return <>
        <button type="button" onClick={() => setRenders((current) => current + 1)}>Rerender host {renders}</button>
        {renderActivity({ React, api: { cron } })}
      </>;
    }

    render(<Host />);
    await screen.findByRole("heading", { name: "Schedule" });
    await waitFor(() => expect(cron.list).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Rerender host/ }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cron.list).toHaveBeenCalledTimes(1);
  });

  it("can use the generic host request helper instead of a built-in cron client", async () => {
    // @ts-expect-error bundled extension web modules are plain JavaScript assets.
    const { renderActivity } = await import("../../extensions/schedule/web.mjs") as { renderActivity: (props: { React: typeof React; api: unknown }) => React.ReactNode };
    const request = vi.fn(async (path: string) => {
      expect(path).toBe("/api/cron");
      return { jobs: [], filePath: "/cron.json" };
    });

    render(<>{renderActivity({ React, api: { request } })}</>);

    expect(await screen.findByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/cron"));
    expect(screen.getByText("/cron.json")).toBeInTheDocument();
  });
});
