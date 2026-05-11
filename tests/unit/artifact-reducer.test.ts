import { describe, expect, it } from "vitest";

import { ARTIFACT_CUSTOM_TYPE, ARTIFACT_SCHEMA_VERSION } from "../../src/shared/artifact.js";
import { initialWebSessionState, reducePiEvent } from "../../src/web/state/pi-event-reducer.js";

describe("pi-event-reducer artifact messages", () => {
  it("captures artifact custom messages into a WebMessage", () => {
    const details = {
      version: ARTIFACT_SCHEMA_VERSION,
      artifactGroupId: "g1",
      artifacts: [
        { mime: "image/png" as const, src: { kind: "url" as const, url: "/api/sessions/s/artifacts/g1.png" } },
        { mime: "text/plain" as const, text: "Image: chart.png (1.2 KB)" },
      ],
    };
    const state = reducePiEvent(initialWebSessionState, {
      type: "message_end",
      message: {
        role: "custom",
        content: "Image: chart.png (1.2 KB)",
        timestamp: 100,
        // pi-sdk shape: extra fields ride alongside the standard WireMessage props
        customType: ARTIFACT_CUSTOM_TYPE,
        details,
      } as unknown as { role: string; content?: unknown; timestamp?: number },
    });
    const message = state.messages.at(-1);
    expect(message?.role).toBe("custom");
    expect(message?.customType).toBe(ARTIFACT_CUSTOM_TYPE);
    expect(message?.artifact?.artifactGroupId).toBe("g1");
    expect(message?.artifact?.artifacts).toHaveLength(2);
  });

  it("does not attach an artifact for unknown customTypes", () => {
    const state = reducePiEvent(initialWebSessionState, {
      type: "message_end",
      message: {
        role: "custom",
        content: "hi",
        timestamp: 1,
        customType: "something-else",
      } as unknown as { role: string; content?: unknown; timestamp?: number },
    });
    expect(state.messages.at(-1)?.artifact).toBeUndefined();
  });
});
