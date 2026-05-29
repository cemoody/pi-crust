/**
 * TDD contract for cross-tab leader election (the actual "many tabs / many
 * connections" fix). RED until implemented.
 *
 * With a shared BroadcastChannel, N tabs on one origin must collapse to ONE
 * underlying transport: a single leader holds the socket; followers subscribe
 * through the channel and receive fanned-out events. If the leader goes away,
 * a follower is promoted and re-opens the transport.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeConnection, type RealtimeConnection } from "../../src/web/api/realtime-connection.js";
import { FakeBroadcastChannel, FakeBroadcastHub, FakeTransport, FakeVisibility, flushMicrotasks } from "../helpers/realtime-client-harness.js";

const conns: RealtimeConnection[] = [];
const transports: FakeTransport[] = [];
function makeTab(hub: FakeBroadcastHub, tabId: string, overrides: Record<string, unknown> = {}): { conn: RealtimeConnection; transport: FakeTransport; channel: FakeBroadcastChannel } {
  const transport = new FakeTransport();
  transports.push(transport);
  const channel = hub.create();
  const conn = createRealtimeConnection({
    tabId,
    broadcast: channel,
    transportFactory: () => transport,
    ...overrides,
  });
  conns.push(conn);
  return { conn, transport, channel };
}
afterEach(() => { for (const c of conns.splice(0)) c.dispose(); transports.splice(0); });

describe("cross-tab leader election", () => {
  it("collapses N tabs to exactly one underlying transport", async () => {
    const hub = new FakeBroadcastHub();
    const a = makeTab(hub, "tab-a");
    const b = makeTab(hub, "tab-b");
    const c = makeTab(hub, "tab-c");

    a.conn.subscribe("s1", () => {});
    b.conn.subscribe("s2", () => {});
    c.conn.subscribe("s3", () => {});
    a.transport.simulateConnect();
    await flushMicrotasks();

    const leaders = [a, b, c].filter((t) => t.conn.isLeader);
    expect(leaders.length).toBe(1);
    const openTransports = transports.filter((t) => t.connected).length;
    expect(openTransports).toBe(1);
  });

  it("fans server events out to follower tabs over the channel", async () => {
    const hub = new FakeBroadcastHub();
    const leader = makeTab(hub, "leader");
    const follower = makeTab(hub, "follower");
    await flushMicrotasks();

    const seen: unknown[] = [];
    follower.conn.subscribe("s1", (e) => seen.push(e));
    leader.transport.simulateConnect();
    await flushMicrotasks();

    // The leader owns the socket and receives the raw event...
    leader.transport.simulateSessionEvent("s1", 1, { type: "agent_start" });
    await flushMicrotasks();

    // ...and the follower (no socket of its own) still sees it.
    expect(follower.conn.isLeader).toBe(false);
    expect(seen).toContainEqual({ type: "agent_start" });
  });

  it("promotes a follower and re-opens the transport when the leader disposes", async () => {
    const hub = new FakeBroadcastHub();
    const leader = makeTab(hub, "leader");
    const follower = makeTab(hub, "follower");
    follower.conn.subscribe("s1", () => {});
    leader.transport.simulateConnect();
    await flushMicrotasks();
    expect(leader.conn.isLeader).toBe(true);

    leader.conn.dispose();
    await flushMicrotasks();
    follower.transport.simulateConnect();
    await flushMicrotasks();

    expect(follower.conn.isLeader).toBe(true);
    // The promoted tab must re-establish s1 on its freshly-opened transport.
    expect(follower.transport.emitsOf("session:subscribe").map((m) => (m.payload as any).sessionId))
      .toContain("s1");
  });

  it("promotes a follower when the leader dies UNGRACEFULLY (no bye, stops heartbeating)", async () => {
    vi.useFakeTimers();
    try {
      const hub = new FakeBroadcastHub();
      const leader = makeTab(hub, "tab-a", { heartbeatMs: 1_000, leaderTimeoutMs: 3_000 });
      const follower = makeTab(hub, "tab-b", { heartbeatMs: 1_000, leaderTimeoutMs: 3_000 });
      follower.conn.subscribe("s1", () => {});
      leader.transport.simulateConnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(leader.conn.isLeader).toBe(true);

      // Crash: kill the leader's channel so it can no longer heartbeat, but do
      // NOT call dispose() (no graceful bye). The follower must time it out.
      leader.channel.close();
      await vi.advanceTimersByTimeAsync(4_000);
      follower.transport.simulateConnect();
      await vi.advanceTimersByTimeAsync(0);

      expect(follower.conn.isLeader).toBe(true);
      expect(follower.transport.emitsOf("session:subscribe").map((m) => (m.payload as any).sessionId)).toContain("s1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands off leadership when the leader tab is backgrounded so visible followers keep streaming", async () => {
    const hub = new FakeBroadcastHub();
    const leaderVis = new FakeVisibility();
    const leader = makeTab(hub, "tab-a", { visibility: leaderVis });
    const follower = makeTab(hub, "tab-b");
    const seen: unknown[] = [];
    follower.conn.subscribe("s1", (e) => seen.push(e));
    leader.transport.simulateConnect();
    await flushMicrotasks();
    expect(leader.conn.isLeader).toBe(true);

    // Background the leader. It must relinquish so a visible follower takes over
    // rather than holding the only socket while hidden.
    leaderVis.set(false);
    await flushMicrotasks();
    follower.transport.simulateConnect();
    await flushMicrotasks();

    expect(leader.conn.isLeader).toBe(false);
    expect(follower.conn.isLeader).toBe(true);

    // New events still reach the visible follower.
    follower.transport.simulateSessionEvent("s1", 1, { type: "agent_start" });
    await flushMicrotasks();
    expect(seen).toContainEqual({ type: "agent_start" });
  });

  it("schedules idle-close when the last want is removed by a follower (no leaked socket)", async () => {
    const hub = new FakeBroadcastHub();
    let now = 0;
    const leader = makeTab(hub, "tab-a", { idleCloseMs: 1_000, now: () => now });
    const follower = makeTab(hub, "tab-b", { idleCloseMs: 1_000, now: () => now });
    const off = follower.conn.subscribe("s1", () => {});
    leader.transport.simulateConnect();
    await flushMicrotasks();
    expect(leader.transport.emitsOf("session:subscribe").some((m) => (m.payload as any).sessionId === "s1")).toBe(true);
    expect(leader.conn.connectionCount).toBe(1);

    off(); // the only want is the follower's; removing it must free the socket
    await flushMicrotasks();
    now = 1_001;
    expect(leader.conn.connectionCount).toBe(0);
  });

  it("reopens the socket when a follower wants a session after the leader went idle", async () => {
    const hub = new FakeBroadcastHub();
    let now = 0;
    const leader = makeTab(hub, "tab-a", { idleCloseMs: 1_000, now: () => now });
    const follower = makeTab(hub, "tab-b", { idleCloseMs: 1_000, now: () => now });
    const off = follower.conn.subscribe("s1", () => {});
    leader.transport.simulateConnect();
    await flushMicrotasks();
    off();
    await flushMicrotasks();
    now = 1_001;
    expect(leader.conn.connectionCount).toBe(0); // idle-closed

    now = 2_000;
    follower.conn.subscribe("s2", () => {});
    await flushMicrotasks();
    leader.transport.simulateConnect();
    await flushMicrotasks();
    expect(leader.conn.connectionCount).toBe(1);
    expect(leader.transport.emitsOf("session:subscribe").some((m) => (m.payload as any).sessionId === "s2")).toBe(true);
  });

  it("still elects exactly one leader when tabs have no stable tab id (empty string)", async () => {
    // getTabSessionId() can return "" before the per-tab telemetry id is set.
    // The connection must self-assign a unique id; otherwise both tabs share
    // tabId "" and ignore each other's claims (every tab stays leader).
    const hub = new FakeBroadcastHub();
    const a = makeTab(hub, "");
    const b = makeTab(hub, "");
    a.conn.subscribe("s1", () => {});
    b.conn.subscribe("s1", () => {});
    a.transport.simulateConnect();
    b.transport.simulateConnect();
    await flushMicrotasks();

    expect([a, b].filter((t) => t.conn.isLeader).length).toBe(1);
    expect([a, b].filter((t) => t.transport.connected).length).toBe(1);
  });

  it("converges to a single leader when two tabs connect simultaneously (no split brain)", async () => {
    const hub = new FakeBroadcastHub();
    const a = makeTab(hub, "tab-a");
    const b = makeTab(hub, "tab-b");
    a.conn.subscribe("s1", () => {});
    b.conn.subscribe("s1", () => {});
    // Both win their socket before hearing each other's claim.
    a.transport.simulateConnect();
    b.transport.simulateConnect();
    await flushMicrotasks();

    const leaders = [a, b].filter((t) => t.conn.isLeader);
    expect(leaders.length).toBe(1);
    expect([a, b].filter((t) => t.transport.connected).length).toBe(1);
  });

  it("cross-tab ref-counts: the leader keeps a wire subscription while ANY tab wants it", async () => {
    const hub = new FakeBroadcastHub();
    const leader = makeTab(hub, "tab-a");
    const follower = makeTab(hub, "tab-b");
    const offLeader = leader.conn.subscribe("s1", () => {});
    const offFollower = follower.conn.subscribe("s1", () => {});
    leader.transport.simulateConnect();
    await flushMicrotasks();

    // One wire subscription for s1 despite two tabs wanting it.
    expect(leader.transport.emitsOf("session:subscribe").filter((m) => (m.payload as any).sessionId === "s1").length).toBe(1);

    offFollower(); // follower no longer wants it, but the leader still does
    await flushMicrotasks();
    expect(leader.transport.emitsOf("session:unsubscribe").length).toBe(0);

    offLeader(); // now nobody wants it
    await flushMicrotasks();
    expect(leader.transport.emitsOf("session:unsubscribe").map((m) => (m.payload as any).sessionId)).toContain("s1");
  });
});
