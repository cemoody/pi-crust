import type { SessionMessage } from "../types.js";
import { hydrateTranscriptSidecars } from "./sidecars.js";
import { toSessionMessages } from "./normalizer.js";

export {
  MAX_INLINE_TRANSCRIPT_BODY_BYTES,
  hydrateTranscriptSidecars,
  persistOversizedTranscriptBodies,
  readTranscriptSidecar,
  transcriptSidecarDirectory,
  transcriptSidecarReference,
} from "./sidecars.js";
export type {
  SidecarizationResult,
  TranscriptBodyReference,
  TranscriptSidecarKind,
} from "./sidecars.js";
export { contentTextAndThinking, toSessionMessages } from "./normalizer.js";

/**
 * Stable transcript boundary for every persisted Pi-message reader.
 *
 * Pi adapters and JSONL tail pagination must both restore content-addressed
 * sidecars before applying the same raw-Pi-to-timeline fan-out. Keeping those
 * operations inseparable prevents one reader from exposing sidecar previews
 * while another exposes the original body or renders a tool result as a
 * standalone message.
 */
export async function loadNormalizedTranscriptMessages(
  sessionFile: string,
  rawMessages: readonly unknown[],
): Promise<SessionMessage[]> {
  return toSessionMessages(await hydrateTranscriptSidecars(sessionFile, rawMessages));
}
