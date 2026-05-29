import { randomUUID } from "node:crypto";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";

/**
 * Drives the interactive OAuth ("subscription") login flow that the Pi TUI
 * exposes via `/login`, but over plain HTTP so the pi-crust web UI can offer
 * the same experience.
 *
 * The underlying `AuthStorage.login(providerId, callbacks)` is a long-running,
 * stateful call: it hands us a browser URL, may prompt for a pasted code, may
 * ask us to pick between options, and (for callback-server providers) races a
 * locally-pasted redirect URL against its own loopback listener. None of that
 * maps onto a single request/response, so we model each login attempt as a
 * "flow" with:
 *
 *   - an append-only event log the client tails by cursor (poll), and
 *   - a set of pending input requests the client satisfies by id (submit).
 *
 * Flows are short-lived and cleaned up after completion or inactivity so an
 * abandoned browser tab can't leak a pending `login()` promise forever.
 */

export type OAuthFlowEvent =
  | { readonly type: "auth"; readonly url: string; readonly instructions?: string }
  | { readonly type: "progress"; readonly message: string }
  | { readonly type: "prompt"; readonly requestId: string; readonly message: string; readonly placeholder?: string; readonly allowEmpty?: boolean }
  | { readonly type: "manualCode"; readonly requestId: string; readonly message: string }
  | { readonly type: "select"; readonly requestId: string; readonly message: string; readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }> }
  | { readonly type: "done" }
  | { readonly type: "error"; readonly message: string };

export type OAuthFlowStatus = "active" | "done" | "error" | "cancelled";

export interface OAuthFlowSnapshot {
  readonly flowId: string;
  readonly provider: string;
  readonly status: OAuthFlowStatus;
  readonly cursor: number;
  readonly events: readonly OAuthFlowEvent[];
  readonly error?: string;
}

interface PendingInput {
  readonly requestId: string;
  resolve(value: string): void;
  reject(error: Error): void;
}

interface OAuthFlow {
  readonly id: string;
  readonly provider: string;
  readonly events: OAuthFlowEvent[];
  readonly pending: Map<string, PendingInput>;
  readonly abort: AbortController;
  status: OAuthFlowStatus;
  error?: string;
  lastActivity: number;
}

/** Flows that never complete are reaped after this much inactivity. */
const FLOW_TTL_MS = 15 * 60_000;

export class OAuthLoginManager {
  private readonly flows = new Map<string, OAuthFlow>();

  constructor(private readonly authStorage: AuthStorage) {}

  /** Provider ids that support the interactive subscription login flow. */
  oauthProviders(): ReadonlyArray<{ id: string; name: string; usesCallbackServer: boolean }> {
    return this.authStorage.getOAuthProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      usesCallbackServer: provider.usesCallbackServer ?? false,
    }));
  }

  start(providerId: string): OAuthFlowSnapshot {
    this.sweep();
    const providerInfo = this.authStorage.getOAuthProviders().find((provider) => provider.id === providerId);
    if (!providerInfo) {
      throw new OAuthLoginError(`Provider "${providerId}" does not support subscription login.`);
    }
    const flow: OAuthFlow = {
      id: randomUUID(),
      provider: providerId,
      events: [],
      pending: new Map(),
      abort: new AbortController(),
      status: "active",
      lastActivity: Date.now(),
    };
    this.flows.set(flow.id, flow);

    const usesCallbackServer = providerInfo.usesCallbackServer ?? false;
    // For callback-server providers the TUI shows a "paste the redirect URL"
    // box the moment the auth URL appears, racing it against the loopback
    // listener. We mirror that by minting the manual-code request up front so
    // `onManualCodeInput()` can hand the provider a promise that the client
    // resolves whenever (or never, if the loopback wins).
    let manualCodePromise: Promise<string> | undefined;

    void this.authStorage
      .login(providerId, {
        onAuth: (info) => {
          this.emit(flow, { type: "auth", url: info.url, ...(info.instructions ? { instructions: info.instructions } : {}) });
          if (usesCallbackServer) {
            manualCodePromise = this.request(flow, (requestId) => ({
              type: "manualCode",
              requestId,
              message: "Paste the redirect URL from your browser, or finish login in the browser tab.",
            }));
            // Swallow rejection here; the provider awaits this promise and will
            // surface a meaningful error/cancel itself.
            manualCodePromise.catch(() => undefined);
          } else if (providerId === "github-copilot") {
            this.emit(flow, { type: "progress", message: "Waiting for browser authentication..." });
          }
        },
        onPrompt: (prompt) =>
          this.request(flow, (requestId) => ({
            type: "prompt",
            requestId,
            message: prompt.message,
            ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
            ...(prompt.allowEmpty ? { allowEmpty: true } : {}),
          })),
        onProgress: (message) => this.emit(flow, { type: "progress", message }),
        onSelect: async (prompt) => {
          const choice = await this.request(flow, (requestId) => ({
            type: "select",
            requestId,
            message: prompt.message,
            options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
          }));
          return choice;
        },
        onManualCodeInput: () => manualCodePromise ?? new Promise<string>(() => undefined),
        signal: flow.abort.signal,
      })
      .then(() => {
        flow.status = "done";
        this.emit(flow, { type: "done" });
      })
      .catch((error: unknown) => {
        if (flow.status === "cancelled") return;
        flow.status = "error";
        const message = error instanceof Error ? error.message : String(error);
        flow.error = message;
        this.emit(flow, { type: "error", message });
      });

    return this.snapshot(flow, 0);
  }

  poll(flowId: string, cursor: number): OAuthFlowSnapshot {
    const flow = this.require(flowId);
    flow.lastActivity = Date.now();
    return this.snapshot(flow, cursor);
  }

  submit(flowId: string, requestId: string, value: string): OAuthFlowSnapshot {
    const flow = this.require(flowId);
    flow.lastActivity = Date.now();
    const pending = flow.pending.get(requestId);
    if (!pending) {
      throw new OAuthLoginError(`No pending input "${requestId}" for this login.`);
    }
    flow.pending.delete(requestId);
    pending.resolve(value);
    return this.snapshot(flow, flow.events.length);
  }

  cancel(flowId: string): OAuthFlowSnapshot {
    const flow = this.require(flowId);
    flow.status = "cancelled";
    flow.abort.abort();
    for (const pending of flow.pending.values()) pending.reject(new Error("Login cancelled"));
    flow.pending.clear();
    this.emit(flow, { type: "error", message: "Login cancelled" });
    return this.snapshot(flow, flow.events.length);
  }

  private snapshot(flow: OAuthFlow, cursor: number): OAuthFlowSnapshot {
    const safeCursor = Math.max(0, Math.min(cursor, flow.events.length));
    return {
      flowId: flow.id,
      provider: flow.provider,
      status: flow.status,
      cursor: flow.events.length,
      events: flow.events.slice(safeCursor),
      ...(flow.error ? { error: flow.error } : {}),
    };
  }

  private emit(flow: OAuthFlow, event: OAuthFlowEvent): void {
    flow.events.push(event);
    flow.lastActivity = Date.now();
  }

  private request(flow: OAuthFlow, build: (requestId: string) => OAuthFlowEvent): Promise<string> {
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      flow.pending.set(requestId, { requestId, resolve, reject });
      this.emit(flow, build(requestId));
    });
  }

  private require(flowId: string): OAuthFlow {
    const flow = this.flows.get(flowId);
    if (!flow) throw new OAuthLoginError(`Unknown login flow "${flowId}". It may have expired; start again.`);
    return flow;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows) {
      const settled = flow.status !== "active";
      const expired = now - flow.lastActivity > FLOW_TTL_MS;
      if ((settled && now - flow.lastActivity > 60_000) || expired) {
        if (flow.status === "active") {
          flow.abort.abort();
          for (const pending of flow.pending.values()) pending.reject(new Error("Login expired"));
        }
        this.flows.delete(id);
      }
    }
  }
}

export class OAuthLoginError extends Error {}
