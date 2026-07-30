import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_JSONL_MESSAGE_BYTES,
  enforceMessagePayloadBudget,
  payloadRefMeta,
  readPayloadRef,
  hydrateMessagePayloadRefs,
} from "../../src/server/pi/extensions/payload-budget.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function context() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-payload-budget-"));
  roots.push(cwd);
  return { cwd, sessionId: "payload-test" };
}

describe("ingest-time transcript payload budget", () => {
  it("externalizes pathological base64 image data before JSONL persistence and restores it on demand", async () => {
    const ctx = await context();
    const base64 = "A".repeat(2 * 1024 * 1024);
    const result = await enforceMessagePayloadBudget({
      role: "user", timestamp: 1,
      content: [{ type: "image", mimeType: "image/png", data: base64 }],
    }, ctx);
    const line = JSON.stringify(result.message);
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_JSONL_MESSAGE_BYTES);
    expect(line).not.toContain(base64);
    const block = (result.message.content as Array<Record<string, unknown>>)[0]!;
    const ref = { __piCrustPayloadRef: block.__piCrustPayloadRef };
    expect(payloadRefMeta(ref)?.bytes).toBe(base64.length);
    expect(await readPayloadRef(ctx, ref)).toBe(base64);
    expect(result.externalized).toEqual([{ reason: "image", bytes: base64.length }]);
    const contextCopy = structuredClone(result.message);
    await hydrateMessagePayloadRefs(contextCopy, ctx);
    expect((contextCopy.content as Array<Record<string, unknown>>)[0]!.data).toBe(base64);
  });

  it("bounds giant tool arguments and preserves exact arguments in a content-addressed payload", async () => {
    const ctx = await context();
    const source = { html: `<div>${"x".repeat(900_000)}</div>`, nested: { accepted: true } };
    const result = await enforceMessagePayloadBudget({
      role: "assistant", timestamp: 2,
      content: [{ type: "toolCall", id: "call-1", name: "show_artifact", arguments: source }],
    }, ctx);
    expect(Buffer.byteLength(JSON.stringify(result.message))).toBeLessThan(MAX_JSONL_MESSAGE_BYTES);
    const argumentsRef = ((result.message.content as Array<Record<string, unknown>>)[0]!.arguments);
    expect(JSON.parse((await readPayloadRef(ctx, argumentsRef))!)).toEqual(source);
    expect(result.externalized[0]?.reason).toBe("tool-arguments");
  });

  it("externalizes huge artifact details while retaining a usable artifact preview and hard-caps arbitrary records", async () => {
    const ctx = await context();
    const html = `<html>${"z".repeat(1_000_000)}</html>`;
    const result = await enforceMessagePayloadBudget({
      role: "toolResult", timestamp: 3, toolCallId: "call-2", content: [{ type: "text", text: "done" }],
      details: { piRemoteControlArtifact: { kind: "html", title: "Huge report", html } },
    }, ctx);
    expect(Buffer.byteLength(JSON.stringify(result.message))).toBeLessThan(MAX_JSONL_MESSAGE_BYTES);
    const artifact = (result.message.details as Record<string, any>).piRemoteControlArtifact;
    expect(artifact).toMatchObject({ kind: "html", title: "Huge report" });
    const raw = await readPayloadRef(ctx, artifact.payloadRef);
    expect(JSON.parse(raw!).piRemoteControlArtifact.html).toBe(html);

    const pathological = await enforceMessagePayloadBudget({ role: "custom", timestamp: 4, content: "x".repeat(900_000) }, ctx);
    expect(Buffer.byteLength(JSON.stringify(pathological.message))).toBeLessThan(MAX_JSONL_MESSAGE_BYTES);
    expect(JSON.stringify(pathological.message)).toContain("Payload externalized");
  });
});
