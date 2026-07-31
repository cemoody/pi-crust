import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

describe("SessionRegistry ↔ SessionLifecycle contract", () => {
  it("replays sequenced adapter events, notifies global observers, and tears down delivery on dispose", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-session-lifecycle-contract-"));
    const projectRoot = path.join(root, "projects");
    const cwd = path.join(projectRoot, "app");
    const sessionRoot = path.join(root, "sessions");
    await fs.mkdir(cwd, { recursive: true });

    try {
      const registry = new SessionRegistry({
        adapter: new MockPiAdapter({ sessionRoot }),
        pathPolicy: new PathPolicy({ allowedProjectRoots: [projectRoot], allowedSessionRoots: [sessionRoot] }),
        eventRingSize: 3,
      });
      const session = await registry.createSession({ cwd });
      const observer = vi.fn();
      const stopObserving = registry.subscribeAll(observer);

      await registry.prompt(session.id, "contract prompt");

      const replay: Array<{ type: string; seq: number }> = [];
      const unsubscribe = registry.subscribeFromSeq(session.id, 0, (event, seq) => replay.push({ type: event.type, seq }));
      expect(replay).toEqual([
        { type: "session_resync", seq: 4 },
        { type: "message", seq: 2 },
        { type: "message", seq: 3 },
        { type: "agent_end", seq: 4 },
      ]);
      expect(observer.mock.calls.map(([, event]) => event.type)).toEqual(["agent_start", "message", "message", "agent_end"]);
      expect(registry.lastSeq(session.id)).toBe(4);
      expect(registry.subscriberCount(session.id)).toBe(1);

      await registry.disposeSession(session.id);
      expect(registry.hasSession(session.id)).toBe(false);
      expect(registry.hotSessionCount).toBe(0);
      expect(registry.subscriberCount(session.id)).toBe(0);
      expect(() => registry.lastSeq(session.id)).toThrow(`Unknown session: ${session.id}`);

      unsubscribe();
      stopObserving();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
