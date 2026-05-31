import { readFileSync } from "node:fs";
import { expect, type APIRequestContext } from "@playwright/test";

// Shared helpers for the image repro fixtures. These talk to the
// already-running live dev server through Playwright's `request` fixture
// (which targets the configured baseURL; the Vite dev server proxies /api to
// the HTTP API). They bootstrap a real session so the specs don't depend on a
// hardcoded session UUID.

export const TEST_IMAGE_PATH = "tests/repro/test-image-input.png";
export const SESSION_CWD = process.env.E2E_SESSION_CWD ?? "/home/coder";
// Escape hatch: reuse an existing session instead of creating a fresh one.
export const REUSE_SESSION_UUID = process.env.E2E_SESSION_UUID ?? "";

export interface PromptAttachment {
  type: "image" | "file";
  name?: string;
  mimeType?: string;
  data?: string; // base64
}

/** Read the bundled test PNG as base64. */
export function testImageBase64(): string {
  return readFileSync(TEST_IMAGE_PATH).toString("base64");
}

/** Create a session and confirm the server accepted it. Returns the id. */
export async function createSession(
  request: APIRequestContext,
  sessionName: string,
): Promise<string> {
  if (REUSE_SESSION_UUID) return REUSE_SESSION_UUID;
  const res = await request.post("/api/sessions", {
    data: { cwd: SESSION_CWD, sessionName },
  });
  expect(res.ok(), `create session failed: ${res.status()}`).toBeTruthy();
  const created = (await res.json()) as { id?: string };
  expect(created.id, "create session returned no id").toBeTruthy();
  return created.id!;
}

/** Send a prompt (optionally with attachments) and wait for it to complete. */
export async function sendPrompt(
  request: APIRequestContext,
  sessionId: string,
  text: string,
  attachments?: PromptAttachment[],
): Promise<void> {
  const res = await request.post(`/api/sessions/${sessionId}/prompt`, {
    data: attachments ? { text, attachments } : { text },
  });
  expect(res.ok(), `prompt failed: ${res.status()}`).toBeTruthy();
}

/**
 * Wait until GET /api/sessions lists the session. A session's jsonl is only
 * persisted (and thus listed) after its first prompt, and the SPA needs the
 * session in that list to resolve `activeSession` and mount the composer.
 */
export async function waitForSessionListed(
  request: APIRequestContext,
  sessionId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/sessions?cwd=${encodeURIComponent(SESSION_CWD)}`);
        if (!res.ok()) return false;
        const list = (await res.json()) as { id: string }[];
        return list.some((s) => s.id === sessionId);
      },
      { timeout: 20000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
}

/**
 * Bootstrap a session that is ready for the UI to open: create it, run a seed
 * prompt (forces jsonl persistence + warms the model), and wait until it is
 * listed. Pass `attachments` to seed via the API attachment path instead of a
 * bare text prompt.
 */
export async function bootstrapSession(
  request: APIRequestContext,
  opts: { sessionName: string; seedText: string; attachments?: PromptAttachment[] },
): Promise<string> {
  const sessionId = await createSession(request, opts.sessionName);
  await sendPrompt(request, sessionId, opts.seedText, opts.attachments);
  await waitForSessionListed(request, sessionId);
  return sessionId;
}

/** Common phrasings a model uses when it cannot see an attached image. */
export const DENIAL_NEEDLES = [
  "cannot see",
  "can't see",
  "don't see",
  "do not see",
  "image omitted",
  "does not support images",
  "no image",
  "unable to see",
];
