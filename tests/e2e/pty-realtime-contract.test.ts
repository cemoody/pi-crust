/**
 * TDD: PTY over the Socket.IO gateway (real socket.io-client ↔ real server).
 * Spec: docs/terminal-wterm-tdd-plan.md contract items 21–25.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  connectRealtimeSocket,
  createRealtimeHarness,
  type RealtimeHarness,
  type RealtimeSocket,
} from "../helpers/realtime-test-harness.js";

const harnesses: RealtimeHarness[] = [];
const sockets: RealtimeSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) { socket.disconnect(); socket.close(); }
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

async function setup(): Promise<RealtimeHarness> {
  const harness = await createRealtimeHarness({ withPty: true });
  harnesses.push(harness);
  return harness;
}
async function connect(baseUrl: string): Promise<RealtimeSocket> {
  const socket = await connectRealtimeSocket(baseUrl);
  sockets.push(socket);
  return socket;
}

describe("PTY realtime contract", () => {
  it("21. opens a pty and streams live output while the socket stays connected", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "term" });
    const socket = await connect(harness.baseUrl);

    const ack = await socket.ptyOpen(session.id);
    expect(ack).toMatchObject({ ok: true, ptyId: expect.stringMatching(/^pty-/) });
    const ptyId = ack.ptyId;

    await socket.ptyInput(ptyId, "echo hi\r");
    await socket.waitPtyData(ptyId, (t) => t.includes("echo hi"));
    expect(socket.ptyText(ptyId)).toContain("echo hi");
    expect(socket.socket.connected).toBe(true);
  });

  it("22. multiplexes two ptys over one socket with zero cross-talk", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "multi" });
    const socket = await connect(harness.baseUrl);

    const a = (await socket.ptyOpen(session.id)).ptyId;
    const b = (await socket.ptyOpen(session.id)).ptyId;
    expect(a).not.toBe(b);

    await socket.ptyInput(a, "AAA\r");
    await socket.ptyInput(b, "BBB\r");
    await socket.waitPtyData(a, (t) => t.includes("AAA"));
    await socket.waitPtyData(b, (t) => t.includes("BBB"));

    expect(socket.ptyText(a)).toContain("AAA");
    expect(socket.ptyText(a)).not.toContain("BBB");
    expect(socket.ptyText(b)).toContain("BBB");
    expect(socket.ptyText(b)).not.toContain("AAA");
    // ONE physical socket served both terminals.
    expect(sockets.filter((s) => s.socket.connected).length).toBe(1);
  });

  it("23. delivers a sustained burst with monotonic seq and no loss", async () => {
    const harness = await setup();
    const session = await harness.createSession({ id: "burst" });
    const socket = await connect(harness.baseUrl);
    const ptyId = (await socket.ptyOpen(session.id)).ptyId;

    await socket.ptyInput(ptyId, "burst 2000\r");
    await socket.waitPtyData(ptyId, (t) => t.includes("line 2000"), 5_000);

    const chunks = socket.ptyData.filter((e) => e.ptyId === ptyId);
    const seqs = chunks.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // monotonic
    expect(new Set(seqs).size).toBe(seqs.length);          // no duplicates
    const text = chunks.map((e) => e.data).join("");
    for (const n of [1, 1000, 2000]) expect(text).toContain(`line ${n}`); // no loss
  });

  it("24. rejects input to an unknown pty via ack; socket stays connected", async () => {
    const harness = await setup();
    await harness.createSession({ id: "reject" });
    const socket = await connect(harness.baseUrl);

    const ack = await socket.ptyInput("pty-does-not-exist", "x");
    expect(ack).toMatchObject({ ok: false, error: expect.stringMatching(/unknown pty/i) });
    expect(socket.socket.connected).toBe(true);
  });

  it("25. rejects pty:open for an unknown session via ack", async () => {
    const harness = await setup();
    const socket = await connect(harness.baseUrl);
    const ack = await socket.ptyOpen("missing-session");
    expect(ack).toMatchObject({ ok: false, error: expect.stringMatching(/unknown session/i) });
    expect(socket.socket.connected).toBe(true);
  });
});
