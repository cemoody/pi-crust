import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MockPiAdapter } from "../../src/server/pi/mock-pi-adapter.js";
import type { PiAdapter, PiSessionHandle } from "../../src/server/pi/types.js";
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

  it("hides subagent sessions from the default session list while keeping them addressable", async () => {
    const { registry, projectA } = await makeRegistry();
    const parent = await registry.createSession({ cwd: projectA, sessionName: "visible parent" });
    const subagent = await registry.createSession({ cwd: projectA, sessionName: "hidden child", subagent: true });

    const listed = await registry.listSessions(projectA);

    expect(listed.map((item) => item.id)).toContain(parent.id);
    expect(listed.map((item) => item.id)).not.toContain(subagent.id);
    await expect(subagent.handle.getState()).resolves.toMatchObject({ id: subagent.id, subagent: true, hiddenFromList: true });
    await expect(registry.getSession(subagent.id).handle.getState()).resolves.toMatchObject({ id: subagent.id });
  });

  it("can include subagent sessions in the list when explicitly requested", async () => {
    const { registry, projectA } = await makeRegistry();
    const parent = await registry.createSession({ cwd: projectA, sessionName: "visible parent" });
    const subagent = await registry.createSession({ cwd: projectA, sessionName: "hidden child", subagent: true });

    const listed = await registry.listSessions(projectA, { includeSubagents: true, includeHidden: true });

    expect(listed.map((item) => item.id)).toEqual(expect.arrayContaining([parent.id, subagent.id]));
    expect(listed.find((item) => item.id === subagent.id)).toMatchObject({ subagent: true, hiddenFromList: true });
  });

  it("defers subagent JSONL metadata until Pi has exclusively created the first session file", async () => {
    const { root, projectA, sessionRoot } = await makeRegistry();
    await fs.mkdir(sessionRoot, { recursive: true });
    const sessionFile = path.join(sessionRoot, "lazy-child.jsonl");
    const id = "lazy-child";
    const handle = {
      id,
      cwd: projectA,
      sessionFile,
      async prompt() {
        // This mirrors Pi SessionManager's first-write behavior: the session
        // file must not exist yet, and the write is exclusive.
        await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id, cwd: projectA })}\n`, { flag: "wx" });
      },
      async getState() { return { id, cwd: projectA, sessionFile, status: "idle", messageCount: 0, lastActivity: Date.now() }; },
      async getMessages() { return []; },
      async abort() {},
      async setSessionName() { return { id, cwd: projectA, sessionFile, status: "idle" as const, messageCount: 0, lastActivity: Date.now() }; },
      async setModel() { return { id, cwd: projectA, sessionFile, status: "idle" as const, messageCount: 0, lastActivity: Date.now() }; },
      subscribe() { return () => {}; },
      async dispose() {},
    } as unknown as PiSessionHandle;
    const adapter = {
      createSession: async () => handle,
      openSession: async () => handle,
      listSessions: async () => [],
      listModels: async () => [],
    } satisfies PiAdapter;
    const registry = new SessionRegistry({
      adapter,
      pathPolicy: new PathPolicy({ allowedProjectRoots: [path.join(root, "projects")], allowedSessionRoots: [sessionRoot] }),
    });

    const subagent = await registry.createSession({ cwd: projectA, sessionName: "deferred child", subagent: true });
    await expect(fs.access(sessionFile)).rejects.toThrow();

    await registry.prompt(subagent.id, "run child work");

    const lines = (await fs.readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { type: "session", id, cwd: projectA },
      expect.objectContaining({ type: "session_info", name: "deferred child", subagent: true, hiddenFromList: true }),
    ]);
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

  it("cloning a session does not duplicate transferred subscriber events", async () => {
    const { registry, projectA } = await makeRegistry();
    const source = await registry.createSession({ cwd: projectA, sessionName: "source" });
    const transferredEvents: string[] = [];
    registry.subscribe(source.id, (event) => transferredEvents.push(event.type));

    const { session: clone } = await registry.cloneSession(source.id);
    await registry.prompt(clone.id, "clone prompt");

    expect(transferredEvents).toEqual(["agent_start", "message", "message", "agent_end"]);
  });

  it("unsubscribes handle listeners when disposing sessions", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });
    const events: string[] = [];
    registry.subscribe(created.id, (event) => events.push(event.type));
    await registry.disposeSession(created.id);

    // The old handle is no longer registry-owned. Emitting through it must not
    // leak into stale subscribers after dispose/replace paths.
    await created.handle.prompt("after dispose");

    expect(events).toEqual([]);
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

  it("getSessionHealthSnapshot returns total/healthy/broken counts", async () => {
    // Regression for the 2026-05-24 outage: the API had no way to surface
    // that 13/14 sessions had silently-broken handles. Now /api/health
    // can return these counts so an operator can `curl /api/health | jq`.
    const { registry, projectA } = await makeRegistry();
    expect(registry.getSessionHealthSnapshot()).toEqual({
      total: 0,
      healthy: 0,
      broken: 0,
      brokenSessionIds: [],
    });

    await registry.createSession({ cwd: projectA });
    await registry.createSession({ cwd: projectA });
    const snap = registry.getSessionHealthSnapshot();
    expect(snap.total).toBe(2);
    // MockPiAdapter handles don't implement isHealthy(); by contract that
    // means "healthy" (the symptom this PR addresses is specific to the
    // PiRpc adapter's socket-backed handles).
    expect(snap.healthy).toBe(2);
    expect(snap.broken).toBe(0);
    expect(snap.brokenSessionIds).toEqual([]);
  });

  it("getSessionHealthSnapshot calls handle.isHealthy() and reports broken sessions", async () => {
    // Simulate the production failure mode: a session whose handle reports
    // isHealthy() === false. The snapshot must classify it as broken and
    // include it in brokenSessionIds so /api/health surfaces it.
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });
    // Patch the handle so its isHealthy() returns false (this is what
    // PiRpcSessionHandle does when its underlying socket has closed).
    const handle = registry.getSession(created.id).handle as { isHealthy?: () => boolean };
    handle.isHealthy = () => false;

    const snap = registry.getSessionHealthSnapshot();
    expect(snap.total).toBe(1);
    expect(snap.healthy).toBe(0);
    expect(snap.broken).toBe(1);
    expect(snap.brokenSessionIds).toEqual([created.id]);
  });

  it("delegates dynamic Pi command discovery and generic slash execution to the session handle", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });
    const handle = registry.getSession(created.id).handle as PiSessionHandle & {
      getCommands: ReturnType<typeof vi.fn>;
      runPiSlashCommand: ReturnType<typeof vi.fn>;
    };
    handle.getCommands = vi.fn(async () => [{ name: "litellm-refresh", source: "extension" as const }]);
    handle.runPiSlashCommand = vi.fn(async () => undefined);

    await expect(registry.getCommands(created.id)).resolves.toEqual([{ name: "litellm-refresh", source: "extension" }]);
    await registry.runPiSlashCommand(created.id, "/litellm-refresh");

    expect(handle.getCommands).toHaveBeenCalledOnce();
    expect(handle.runPiSlashCommand).toHaveBeenCalledWith("/litellm-refresh");
  });

  it("returns no dynamic commands and rejects generic slash execution when adapter support is missing", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });

    await expect(registry.getCommands(created.id)).resolves.toEqual([]);
    await expect(registry.runPiSlashCommand(created.id, "hello")).rejects.toThrow(/slash command/i);
    await expect(registry.runPiSlashCommand(created.id, "")).rejects.toThrow(/slash command/i);
    await expect(registry.runPiSlashCommand(created.id, "/litellm-refresh")).rejects.toThrow(/does not support generic Pi slash commands/i);
  });

  // --- Feature B: self-healing registry --------------------------------------
  // Regression guard for the 2026-05-29 "dead handle" outage. The heavyweight,
  // out-of-process reproduction lives in tests/scenarios/enoent-self-heals.test.ts
  // (run via `npm run scenarios`); these in-process unit tests run in CI on
  // every PR.
  it("isSessionHealthy reflects a registered handle's liveness (and false for unknown)", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });

    // Mock handles have no isHealthy() -> healthy by convention.
    expect(registry.isSessionHealthy(created.id)).toBe(true);
    expect(registry.isSessionHealthy("no-such-session")).toBe(false);

    // Simulate the detached worker dying: the handle reports unhealthy.
    const handle = registry.getSession(created.id).handle as PiSessionHandle & { isHealthy?: () => boolean };
    handle.isHealthy = () => false;
    expect(registry.isSessionHealthy(created.id)).toBe(false);
  });

  it("evictDeadSession forgets a dead session without disposing the (gone) worker", async () => {
    const { registry, projectA } = await makeRegistry();
    const created = await registry.createSession({ cwd: projectA });
    const handle = registry.getSession(created.id).handle as PiSessionHandle & {
      isHealthy?: () => boolean;
      dispose: ReturnType<typeof vi.fn>;
      detach?: ReturnType<typeof vi.fn>;
    };
    const disposeSpy = vi.spyOn(handle, "dispose");
    handle.isHealthy = () => false;

    const evicted = await registry.evictDeadSession(created.id);
    expect(evicted).toBe(true);
    expect(registry.hasSession(created.id)).toBe(false);
    expect(registry.hotSessionCount).toBe(0);
    // Must NOT RPC-shutdown the dead worker (it no longer answers).
    expect(disposeSpy).not.toHaveBeenCalled();

    // Idempotent / safe on unknown ids.
    expect(await registry.evictDeadSession(created.id)).toBe(false);
    expect(await registry.evictDeadSession("never-existed")).toBe(false);

    // The transcript on disk survives eviction, so the session is reopenable
    // (this is what lets getOrOpenSession re-spawn a fresh worker).
    const reopened = await registry.openSession(created.sessionFile);
    expect(reopened.id).toBe(created.id);
    expect(registry.isSessionHealthy(created.id)).toBe(true);
  });
});
