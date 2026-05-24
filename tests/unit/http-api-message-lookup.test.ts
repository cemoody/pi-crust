/**
 * TDD characterization for `lookupSessionMessage`: the small helper that
 * collapses the duplicated session-open + getMessages + findMessageById
 * dance shared by /api/sessions/:id/messages/:msgid/{images/N,details,
 * tool-output} into one call.
 *
 * Written before the helper lands. Initially RED (import fails), GREEN
 * once the helper is in place.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../../src/server/pi/types.js";
import { lookupSessionMessage } from "../../src/server/http-api-message-lookup.js";

function fakeContext(messages: readonly SessionMessage[]) {
  const session = {
    id: "fake-session",
    sessionFile: "/tmp/fake.jsonl",
    handle: {
      id: "fake-session",
      getMessages: vi.fn(async () => messages),
    },
  };
  return {
    getOrOpenSession: vi.fn(async () => session),
    session,
  };
}

// Messages don't carry a stable id field on disk — toDashboardMessages
// synthesizes one from `${timestamp}-${positionalIndex}` and that's what
// the HTTP routes pass back here. Mirror that contract in the tests.
const msg = (timestamp: number, content: string, role: SessionMessage["role"] = "assistant"): SessionMessage =>
  ({ role, content, timestamp });

describe("lookupSessionMessage", () => {
  it("returns the message at the index encoded in the synthetic `${timestamp}-${index}` id", async () => {
    const messages = [
      msg(100, "hi", "user"),       // synth id "100-0"
      msg(200, "target"),            // synth id "200-1"
      msg(300, "tail"),              // synth id "300-2"
    ];
    const ctx = fakeContext(messages);
    const result = await lookupSessionMessage(
      { getOrOpenSession: ctx.getOrOpenSession },
      "fake-session",
      "200-1",
    );
    expect(result).toBe(messages[1]);
    expect(ctx.getOrOpenSession).toHaveBeenCalledWith("fake-session");
  });

  it("returns undefined when the synthetic id doesn't match any (timestamp, index) pair", async () => {
    const ctx = fakeContext([msg(100, "hi")]);
    const result = await lookupSessionMessage(
      { getOrOpenSession: ctx.getOrOpenSession },
      "fake-session",
      "999-7",
    );
    expect(result).toBeUndefined();
  });

  it("distinguishes two messages with the same timestamp by index", async () => {
    const messages = [msg(500, "first"), msg(500, "second")];
    const ctx = fakeContext(messages);
    expect(
      await lookupSessionMessage({ getOrOpenSession: ctx.getOrOpenSession }, "s", "500-0"),
    ).toBe(messages[0]);
    expect(
      await lookupSessionMessage({ getOrOpenSession: ctx.getOrOpenSession }, "s", "500-1"),
    ).toBe(messages[1]);
  });

  it("returns undefined for an empty message list", async () => {
    const ctx = fakeContext([]);
    expect(
      await lookupSessionMessage({ getOrOpenSession: ctx.getOrOpenSession }, "fake-session", "any-id"),
    ).toBeUndefined();
  });
});
