import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { SessionRegistry } from "../../src/server/session/session-registry.js";

async function makeRegistry() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-crust-test-"));
  const projectRoot = path.join(root, "projects");
  const projectA = path.join(projectRoot, "a");
  const projectB = path.join(projectRoot, "b");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(projectB, { recursive: true });
  const adapter = new MockPiAdapter({ sessionRoot });
  const registry = new SessionRegistry({
    adapter,
    pathPolicy: new PathPolicy({
      allowedProjectRoots: [projectRoot],
      allowedSessionRoots: [sessionRoot],
    }),
  });
  return { root, projectRoot, projectA, projectB, sessionRoot, registry };
}

describe("SessionRegistry", () => {
  it("creates two independent sessions with distinct ids and files", async () => {
    const { registry, projectA } = await makeRegistry();
    const first = await registry.createSession({ cwd: projectA });
    const second = await registry.createSession({ cwd: projectA });

    expect(first.id).not.toBe(second.id);
    expect(first.sessionFile).not.toBe(second.sessionFile);
    expect(registry.hotSessionCount).toBe(2);
  });

  it("prompting one session does not append messages to another", async () => {
    const { registry, projectA } = await makeRegistry();
    const first = await registry.createSession({ cwd: projectA });
    const second = await registry.createSession({ cwd: projectA });

    await registry.prompt(first.id, "hello first");

    await expect(first.handle.getMessages()).resolves.toHaveLength(2);
    await expect(second.handle.getMessages()).resolves.toHaveLength(0);
  });

  it("aborting one session does not alter another session", async () => {
    const { registry, projectA } = await makeRegistry();
    const first = await registry.createSession({ cwd: projectA });
    const second = await registry.createSession({ cwd: projectA });
    await registry.prompt(second.id, "hello second");

    await registry.abort(first.id);

    await expect(first.handle.getMessages()).resolves.toHaveLength(0);
    await expect(second.handle.getMessages()).resolves.toHaveLength(2);
  });

  it("lists newly created persistent sessions", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA, sessionName: "test session" });

    const listed = await registry.listSessions(projectA);

    expect(listed.map((item) => item.id)).toContain(created.id);
    expect(listed[0]?.sessionName).toBe("test session");
  });

  it("persists renamed sessions across reopen and list", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });

    const renamed = await registry.setSessionName(created.id, "Renamed work");
    expect(renamed.sessionName).toBe("Renamed work");
    await registry.disposeSession(created.id);

    const reopened = await registry.openSession(created.sessionFile);
    await expect(reopened.handle.getState()).resolves.toMatchObject({ sessionName: "Renamed work" });
    const listed = await registry.listSessions(projectA);
    expect(listed.find((session) => session.id === created.id)?.sessionName).toBe("Renamed work");
  });

  it("disposes hot session while keeping it reopenable from disk", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });
    await registry.prompt(created.id, "persist me");

    await registry.disposeSession(created.id);

    expect(registry.hotSessionCount).toBe(0);
    const reopened = await registry.openSession(created.sessionFile);
    await expect(reopened.handle.getMessages()).resolves.toHaveLength(2);
  });

  it("forking a session keeps the source session alive and creates an independent fork", async () => {
    const { registry, projectA } = await makeRegistry();
    const source = await registry.createSession({ cwd: projectA, sessionName: "source" });
    await registry.prompt(source.id, "original prompt");
    const forkPoint = (await registry.getForkMessages(source.id))[0];
    expect(forkPoint).toBeDefined();

    const { result, session: fork } = await registry.forkSession(source.id, forkPoint!.entryId);

    expect(result).toMatchObject({ cancelled: false, text: "original prompt" });
    expect(fork.id).not.toBe(source.id);
    expect(registry.hotSessionCount).toBe(2);

    await registry.prompt(source.id, "continue source");
    await registry.prompt(fork.id, "continue fork");

    await expect(source.handle.getMessages()).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "original prompt" }),
      expect.objectContaining({ role: "assistant", content: "Mock response to: original prompt" }),
      expect.objectContaining({ role: "user", content: "continue source" }),
      expect.objectContaining({ role: "assistant", content: "Mock response to: continue source" }),
    ]);
    await expect(fork.handle.getMessages()).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "continue fork" }),
      expect.objectContaining({ role: "assistant", content: "Mock response to: continue fork" }),
    ]);
  });

  it("forking a session does not mutate the source handle identity", async () => {
    const { registry, projectA } = await makeRegistry();
    const source = await registry.createSession({ cwd: projectA, sessionName: "source" });
    await registry.prompt(source.id, "original prompt");
    const forkPoint = (await registry.getForkMessages(source.id))[0]!;
    const originalSourceId = source.id;
    const originalSourceFile = source.sessionFile;

    const { session: fork } = await registry.forkSession(source.id, forkPoint.entryId);

    expect(source.id).toBe(originalSourceId);
    expect(source.sessionFile).toBe(originalSourceFile);
    expect(source.handle.id).toBe(originalSourceId);
    expect(source.handle.sessionFile).toBe(originalSourceFile);
    expect(fork.id).not.toBe(originalSourceId);
    expect(registry.hasSession(originalSourceId)).toBe(true);
    expect(registry.hasSession(fork.id)).toBe(true);
  });

  it("forking a session keeps source subscribers attached to the source instead of moving them to the fork", async () => {
    const { registry, projectA } = await makeRegistry();
    const source = await registry.createSession({ cwd: projectA, sessionName: "source" });
    await registry.prompt(source.id, "original prompt");
    const forkPoint = (await registry.getForkMessages(source.id))[0]!;
    const sourceEvents: string[] = [];
    registry.subscribe(source.id, (event) => sourceEvents.push(event.type));

    const { session: fork } = await registry.forkSession(source.id, forkPoint.entryId);
    await registry.prompt(fork.id, "fork-only prompt");

    expect(sourceEvents).toEqual([]);
  });

  it("deletes the persisted session file so deleted sessions do not reappear in lists", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });
    await registry.prompt(created.id, "delete me");

    await registry.deleteSession(created.id);

    expect(registry.hotSessionCount).toBe(0);
    await expect(fs.access(created.sessionFile)).rejects.toThrow();
    const listed = await registry.listSessions(projectA);
    expect(listed.map((item) => item.id)).not.toContain(created.id);
    await expect(registry.openSession(created.sessionFile)).rejects.toThrow();
  });

  it("rejects unknown session ids with a typed error message", async () => {
    const { registry } = await makeRegistry();
    await expect(registry.prompt("missing", "hello")).rejects.toThrow("Unknown session: missing");
  });

  it("rejects cwd values outside the configured project roots", async () => {
    const { registry, root } = await makeRegistry();
    await expect(registry.createSession({ cwd: path.join(root, "outside") })).rejects.toThrow(
      "Cwd is outside allowed project roots",
    );
  });

  it("rejects session files outside the configured session roots", async () => {
    const { registry, root } = await makeRegistry();
    await expect(registry.openSession(path.join(root, "outside-session.json"))).rejects.toThrow(
      "Session file is outside allowed session roots",
    );
  });

  it("mock adapter emits deterministic events without network/API keys", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });
    const events: string[] = [];
    registry.subscribe(created.id, (event) => events.push(event.type));

    await registry.prompt(created.id, "hello");

    expect(events).toEqual(["agent_start", "message", "message", "agent_end"]);
  });
});
