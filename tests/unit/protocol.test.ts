import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../src/shared/version.js";
import { parseClientEnvelope } from "../../src/shared/protocol.js";
import { SessionEventFanout } from "../../src/server/protocol/session-event-fanout.js";
import { truncateText, truncateWithEllipsis } from "../../src/shared/truncation.js";

describe("protocol", () => {
  it("parses valid client envelopes", () => {
    const parsed = parseClientEnvelope(JSON.stringify({
      id: "1",
      type: "client_op",
      protocolVersion: PROTOCOL_VERSION,
      op: { op: "get_available_models" },
    }));

    expect("id" in parsed && parsed.id).toBe("1");
  });

  it("rejects malformed JSON with a typed error", () => {
    expect(parseClientEnvelope("{")).toMatchObject({ code: "bad_json" });
  });

  it("rejects version mismatches with reload guidance", () => {
    const parsed = parseClientEnvelope(JSON.stringify({
      id: "1",
      type: "client_op",
      protocolVersion: 999,
      op: { op: "get_available_models" },
    }));

    expect(parsed).toMatchObject({ code: "version_mismatch" });
    expect("message" in parsed ? parsed.message : "").toContain("reload");
  });

  it("fans out events only to subscribers for the matching session", () => {
    const fanout = new SessionEventFanout();
    const sessionA: unknown[] = [];
    const sessionB: unknown[] = [];
    fanout.subscribe("a", (message) => sessionA.push(message));
    fanout.subscribe("b", (message) => sessionB.push(message));

    fanout.publish("a", { type: "agent_start" });

    expect(sessionA).toHaveLength(1);
    expect(sessionB).toHaveLength(0);
  });

  it("truncates large tool streams according to protocol rules", () => {
    const result = truncateText("abcdef", 4);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(6);
    expect(result.text).toHaveLength(4);
  });

  it("truncates compact labels with an ellipsis while preserving their maximum length", () => {
    expect(truncateWithEllipsis("abcdef", 4)).toBe("abc…");
    expect(truncateWithEllipsis("abc", 4)).toBe("abc");
    expect(truncateWithEllipsis("abcdef", 0)).toBe("");
    expect(() => truncateWithEllipsis("abc", -1)).toThrow("maxChars must be >= 0");
  });
});
