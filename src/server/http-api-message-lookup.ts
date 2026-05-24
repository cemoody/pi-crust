/**
 * Shared helper that collapses the duplicated session-open +
 * getMessages + findMessageById dance used by the
 * /api/sessions/:id/messages/:msgid/{images/N,details,tool-output}
 * routes in http-api-server.ts.
 *
 * Extracted to its own module so it's directly unit-testable without the
 * full HttpApiServerContext shape. The route handlers pass in a
 * `getOrOpenSession` callback bound to the request's context.
 *
 * Pinned by tests/unit/http-api-message-lookup.test.ts.
 */
import type { SessionMessage } from "./pi/types.js";

export interface MessageLookupContext {
  readonly getOrOpenSession: (sessionId: string) => Promise<{
    readonly handle: { getMessages(): Promise<readonly SessionMessage[]> };
  }>;
}

/**
 * Resolve a synthetic per-session message id of the form `${timestamp}-${index}`
 * back to the matching SessionMessage. The synthetic id is what
 * toDashboardMessages emits and what the message-detail HTTP routes
 * receive in their URLs.
 */
export async function lookupSessionMessage(
  context: MessageLookupContext,
  sessionId: string,
  syntheticMessageId: string,
): Promise<SessionMessage | undefined> {
  const session = await context.getOrOpenSession(sessionId);
  const messages = await session.handle.getMessages();
  for (let index = 0; index < messages.length; index++) {
    const candidate = messages[index]!;
    if (`${candidate.timestamp}-${index}` === syntheticMessageId) return candidate;
  }
  return undefined;
}
