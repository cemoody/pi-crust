import { describe, expect, it } from "vitest";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import { OAuthLoginManager, OAuthLoginError } from "../../src/server/auth/oauth-login-manager.js";

/**
 * The interactive OAuth flow can't hit a real provider in tests, so we drive
 * the manager with a fake AuthStorage whose login() exercises every callback
 * the manager wires up (onAuth, onPrompt, onSelect, onManualCodeInput).
 */
interface LoginCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  onProgress?: (message: string) => void;
  onSelect?: (prompt: { message: string; options: Array<{ id: string; label: string }> }) => Promise<string | undefined>;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
}

function fakeAuthStorage(options: {
  providers?: Array<{ id: string; name: string; usesCallbackServer?: boolean }>;
  run: (callbacks: LoginCallbacks) => Promise<void>;
}): AuthStorage {
  const providers = options.providers ?? [{ id: "anthropic", name: "Anthropic", usesCallbackServer: true }];
  return {
    getOAuthProviders: () => providers,
    login: (_providerId: string, callbacks: LoginCallbacks) => options.run(callbacks),
  } as unknown as AuthStorage;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("OAuthLoginManager", () => {
  it("rejects providers that don't support subscription login", () => {
    const manager = new OAuthLoginManager(fakeAuthStorage({ run: async () => undefined }));
    expect(() => manager.start("not-a-provider")).toThrow(OAuthLoginError);
  });

  it("emits the auth URL, satisfies a prompt, and completes", async () => {
    let resolveCode: ((code: string) => void) | undefined;
    const manager = new OAuthLoginManager(
      fakeAuthStorage({
        providers: [{ id: "anthropic", name: "Anthropic", usesCallbackServer: false }],
        run: async (callbacks) => {
          callbacks.onAuth({ url: "https://example.com/auth", instructions: "Sign in" });
          const code = await callbacks.onPrompt({ message: "Paste the code" });
          if (code !== "the-code") throw new Error(`unexpected code ${code}`);
          resolveCode?.(code);
        },
      }),
    );

    const started = manager.start("anthropic");
    expect(started.status).toBe("active");
    await tick();

    let snapshot = manager.poll(started.flowId, 0);
    const auth = snapshot.events.find((event) => event.type === "auth");
    expect(auth).toMatchObject({ type: "auth", url: "https://example.com/auth", instructions: "Sign in" });
    const prompt = snapshot.events.find((event) => event.type === "prompt");
    expect(prompt && prompt.type === "prompt" ? prompt.message : null).toBe("Paste the code");

    const requestId = prompt && prompt.type === "prompt" ? prompt.requestId : "";
    manager.submit(started.flowId, requestId, "the-code");
    await tick();
    await tick();

    snapshot = manager.poll(started.flowId, 0);
    expect(snapshot.status).toBe("done");
    expect(snapshot.events.some((event) => event.type === "done")).toBe(true);
  });

  it("offers a manual-code request for callback-server providers and resolves it", async () => {
    const manager = new OAuthLoginManager(
      fakeAuthStorage({
        providers: [{ id: "openai-codex", name: "Codex", usesCallbackServer: true }],
        run: async (callbacks) => {
          callbacks.onAuth({ url: "https://example.com/codex" });
          const pasted = await callbacks.onManualCodeInput!();
          if (pasted !== "redirect-url") throw new Error("wrong url");
        },
      }),
    );

    const started = manager.start("openai-codex");
    await tick();
    const snapshot = manager.poll(started.flowId, 0);
    const manual = snapshot.events.find((event) => event.type === "manualCode");
    expect(manual?.type).toBe("manualCode");
    const requestId = manual && manual.type === "manualCode" ? manual.requestId : "";

    manager.submit(started.flowId, requestId, "redirect-url");
    await tick();
    await tick();
    expect(manager.poll(started.flowId, 0).status).toBe("done");
  });

  it("drives an interactive select prompt", async () => {
    const manager = new OAuthLoginManager(
      fakeAuthStorage({
        providers: [{ id: "anthropic", name: "Anthropic", usesCallbackServer: false }],
        run: async (callbacks) => {
          const choice = await callbacks.onSelect!({ message: "Pick one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
          if (choice !== "b") throw new Error("wrong choice");
        },
      }),
    );

    const started = manager.start("anthropic");
    await tick();
    const select = manager.poll(started.flowId, 0).events.find((event) => event.type === "select");
    expect(select?.type).toBe("select");
    const requestId = select && select.type === "select" ? select.requestId : "";
    manager.submit(started.flowId, requestId, "b");
    await tick();
    await tick();
    expect(manager.poll(started.flowId, 0).status).toBe("done");
  });

  it("surfaces login failures as error events", async () => {
    const manager = new OAuthLoginManager(
      fakeAuthStorage({
        providers: [{ id: "anthropic", name: "Anthropic" }],
        run: async () => {
          throw new Error("boom");
        },
      }),
    );
    const started = manager.start("anthropic");
    await tick();
    const snapshot = manager.poll(started.flowId, 0);
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe("boom");
    expect(snapshot.events.some((event) => event.type === "error")).toBe(true);
  });

  it("cancels an in-flight flow and aborts the login signal", async () => {
    let aborted = false;
    const manager = new OAuthLoginManager(
      fakeAuthStorage({
        providers: [{ id: "anthropic", name: "Anthropic" }],
        run: async (callbacks) => {
          callbacks.onAuth({ url: "https://example.com" });
          callbacks.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          await new Promise<string>(() => undefined);
        },
      }),
    );
    const started = manager.start("anthropic");
    await tick();
    const snapshot = manager.cancel(started.flowId);
    expect(snapshot.status).toBe("cancelled");
    expect(aborted).toBe(true);
  });

  it("returns only events after the polled cursor", async () => {
    const manager = new OAuthLoginManager(
      fakeAuthStorage({
        providers: [{ id: "anthropic", name: "Anthropic", usesCallbackServer: false }],
        run: async (callbacks) => {
          callbacks.onAuth({ url: "https://example.com" });
          callbacks.onProgress?.("step one");
          await callbacks.onPrompt({ message: "code" });
        },
      }),
    );
    const started = manager.start("anthropic");
    await tick();
    const first = manager.poll(started.flowId, 0);
    expect(first.events.length).toBeGreaterThan(0);
    const second = manager.poll(started.flowId, first.cursor);
    expect(second.events).toHaveLength(0);
    expect(second.cursor).toBe(first.cursor);
  });
});
