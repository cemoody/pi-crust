import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CUSTOM_TYPE,
  ARTIFACT_SCHEMA_VERSION,
  type ArtifactMessageDetails,
  extensionForMime,
  isArtifactMessage,
  isArtifactMessageDetails,
  pickRepresentation,
} from "../../src/shared/artifact.js";

describe("shared/artifact", () => {
  it("recognizes well-formed artifact messages", () => {
    const details: ArtifactMessageDetails = {
      version: ARTIFACT_SCHEMA_VERSION,
      artifactGroupId: "abc",
      artifacts: [
        { mime: "image/png", src: { kind: "url", url: "/api/sessions/s/artifacts/abc.png" } },
        { mime: "text/plain", text: "fallback" },
      ],
    };
    expect(isArtifactMessageDetails(details)).toBe(true);
    expect(
      isArtifactMessage({ role: "custom", customType: ARTIFACT_CUSTOM_TYPE, details }),
    ).toBe(true);
    expect(
      isArtifactMessage({ role: "custom", customType: "other", details }),
    ).toBe(false);
    expect(isArtifactMessageDetails({})).toBe(false);
    expect(isArtifactMessageDetails({ version: 99, artifactGroupId: "x", artifacts: [] })).toBe(false);
  });

  it("picks representations by supported mime order", () => {
    const arts = [
      { mime: "text/plain", text: "fallback" },
      { mime: "image/png", src: { kind: "url", url: "/x" } },
    ] as const;
    expect(pickRepresentation(arts, ["image/png", "text/plain"])?.mime).toBe("image/png");
    expect(pickRepresentation(arts, ["text/plain"])?.mime).toBe("text/plain");
    expect(pickRepresentation(arts, ["text/html"])).toBeUndefined();
  });

  it("maps MIME to file extension", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("application/vnd.vega-lite.v5+json")).toBe("vl.json");
    expect(extensionForMime("application/octet-stream")).toBe("bin");
  });
});
