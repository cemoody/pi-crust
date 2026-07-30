import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enforceMessagePayloadBudget, hydrateMessagePayloadRefs, hydrateToolCallInput, type PayloadBudgetContext } from "./payload-budget.js";

/**
 * Pi-worker ingress guard: message_end fires before SessionManager appends the
 * message to its JSONL. Replacing it here is therefore the only place we can
 * guarantee a malicious/accidental base64 blob never becomes a giant record.
 */
export default function payloadBudgetExtension(pi: ExtensionAPI) {
  const context = (ctx: any): PayloadBudgetContext | undefined => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const cwd = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.();
    return typeof sessionId === "string" && sessionId && typeof cwd === "string" && cwd ? { sessionId, cwd } : undefined;
  };

  const on: any = pi.on.bind(pi);
  on("context", async (event: any, ctx: any) => {
    const budget = context(ctx);
    if (!budget || !Array.isArray(event?.messages)) return undefined;
    for (const message of event.messages) {
      if (message && typeof message === "object") await hydrateMessagePayloadRefs(message, budget);
    }
    return undefined;
  });

  on("tool_call", async (event: any, ctx: any) => {
    const budget = context(ctx);
    if (budget && event?.input && typeof event.input === "object") await hydrateToolCallInput(event.input, budget);
  });

  on("message_end", async (event: any, ctx: any) => {
    const budget = context(ctx);
    if (!budget || !event?.message || typeof event.message !== "object") return undefined;
    const result = await enforceMessagePayloadBudget(event.message, budget);
    if (result.externalized.length > 0) {
      // Observable, structured warning without copying the payload itself.
      console.warn(JSON.stringify({ event: "pi_crust.transcript_payload_externalized", sessionId: budget.sessionId, records: result.externalized }));
    }
    return { message: result.message };
  });
}
